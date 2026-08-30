// Package permission decides, for one proposed tool call, whether the agent
// may run it now, must ask the user first, or may not run it at all.
//
// It answers a different question from internal/agent/workspace, and the
// split is load-bearing. Containment answers "is this path even in scope?"
// -- not negotiable, no mode relaxes it, an approved write to
// ../../.ssh/authorized_keys is still that write. Permission answers "is the
// agent allowed to do this?" -- policy, which a user can and should be able
// to relax. Phase 2 shipped the first without the second, which is why an
// agent could create, overwrite and edit files, and run arbitrary shell
// commands, with nothing standing in front of either.
//
// Ported from OpenWorker's coworker/permissions.py; see
// docs/agentic-loop-implementation-plan.md §2.5.
//
// The engine only *decides*. Routing a needs-user decision to a surface,
// collecting the answer, and remembering it is the caller's job -- here,
// internal/api/chat.
package permission

import (
	"encoding/json"
	"fmt"
	"strings"

	"amiro/backend/internal/agent/workspace"
	"amiro/backend/internal/ai/tools"
)

// Mode is how much the agent may do without asking.
type Mode string

const (
	// ModePlan is read-only. Nothing consequential runs, and nothing is
	// asked either -- a denial in Plan mode is the answer, not a prompt.
	// This is the mode a user picks to let an agent look around a codebase
	// they don't want it touching yet.
	ModePlan Mode = "plan"

	// ModeInteractive auto-runs reads, and asks before writes and commands.
	// The default, and the only mode where the approval UI appears.
	ModeInteractive Mode = "interactive"

	// ModeEdit automatically runs reads and file writes/edits, but asks before
	// running shell commands or arbitrary external executions.
	ModeEdit Mode = "edit"

	// ModeAuto runs everything without asking. Still path-scoped: Auto
	// relaxes policy, never containment.
	ModeAuto Mode = "auto"
)

// ParseMode maps a request's string to a Mode, defaulting to Interactive.
//
// An unrecognized value defaults to the *asking* mode rather than erroring
// or falling through to Auto. A typo in a client should cost a prompt.
func ParseMode(s string) Mode {
	normalized := strings.TrimSpace(strings.ToLower(s))
	switch Mode(normalized) {
	case ModePlan:
		return ModePlan
	case ModeAuto:
		return ModeAuto
	case ModeEdit, "auto_edit", "edit_automatically":
		return ModeEdit
	case ModeInteractive, "manual":
		return ModeInteractive
	default:
		return ModeInteractive
	}
}

// Decision is the engine's verdict on one call.
type Decision struct {
	// Allowed means run it now.
	Allowed bool
	// NeedsUser means suspend and ask. Never set together with Allowed.
	NeedsUser bool
	// Reason is shown to the user on an approval card and fed back to the
	// model on a denial, so it has to read as an explanation rather than an
	// error code -- a model that can see *why* it was refused picks a
	// different approach instead of retrying the same call.
	Reason string
}

func allow(reason string) Decision  { return Decision{Allowed: true, Reason: reason} }
func ask(reason string) Decision    { return Decision{NeedsUser: true, Reason: reason} }
func refuse(reason string) Decision { return Decision{Reason: reason} }

// Call is one proposed tool invocation, in the only terms the engine needs.
type Call struct {
	Tool  string
	Risk  tools.Risk
	Input json.RawMessage
	// CommandLine renders the call as a command line for allowlist
	// matching, for tools whose consequential argument is a command. See
	// tools.Definition.CommandLine.
	CommandLine func(json.RawMessage) string

	// AlwaysAsk means this exact call requires the user's approval every
	// time, in every mode including Auto, bypassing both the mode
	// shortcuts below and any "always allow" the session already
	// remembers for this tool or command -- see tools.Definition.AlwaysAsk
	// and docs/coding-agent-parity/04-git-remote-operations.md. Only git's
	// push subcommand and create_pr ever set this.
	AlwaysAsk bool
}

// CallFor builds a Call from a tool definition and its arguments.
func CallFor(def tools.Definition, input json.RawMessage) Call {
	var alwaysAsk bool
	if def.AlwaysAsk != nil {
		alwaysAsk = def.AlwaysAsk(input)
	}
	return Call{Tool: def.Name, Risk: def.Risk, Input: input, CommandLine: def.CommandLine, AlwaysAsk: alwaysAsk}
}

// Engine evaluates calls against a mode, a workspace, and a growing set of
// things the user has already said yes to.
//
// Safe for concurrent use: the tool scheduler evaluates parallel calls from
// several goroutines, and an "always allow" answer can land from a
// different request entirely while one is in flight.
type Engine struct {
	mode Mode
	ws   *workspace.Workspace

	// allowedCommands are command-line prefixes that run without asking.
	// Static for the process; user-extensible via configuration.
	allowedCommands []string

	// session is what the user has already said "always allow" to in this
	// conversation. Shared by reference with the Store, and re-read on every
	// check, so a grant minted mid-turn applies to the next call in the same
	// turn rather than only to the next request.
	session *Session

	// trusted mirrors a workspace_trust row for (user, ws.Root()) --
	// docs/coding-agent-parity/01-workspace-trust-and-rules.md. Defaults to
	// true in New so every existing call site (tests, subagents, and any
	// caller that predates the trust-grant model) keeps refusing exactly
	// what it refused before; a caller that actually has a grant to check
	// sets it explicitly via WithTrust.
	trusted bool
}

// New builds an engine. ws may be nil, in which case no file tools exist to
// scope and only the command rules do any work. session may be nil, which
// degrades to an engine that never remembers an answer. The engine starts
// trusted; a caller resolving a real trust grant calls WithTrust to narrow
// it.
func New(mode Mode, ws *workspace.Workspace, allowedCommands []string, session *Session) *Engine {
	return &Engine{mode: mode, ws: ws, allowedCommands: allowedCommands, session: session, trusted: true}
}

// WithTrust sets whether this engine's workspace has a trust grant, and
// returns the same engine for chaining at the construction site. An
// untrusted engine refuses every consequential risk class outright -- see
// Evaluate -- regardless of mode, including Auto: mode controls how much
// the agent may do once trusted, it is not itself the trust gesture.
func (e *Engine) WithTrust(trusted bool) *Engine {
	e.trusted = trusted
	return e
}

// Trusted reports the engine's current trust state.
func (e *Engine) Trusted() bool { return e.trusted }

// Mode reports the engine's mode.
func (e *Engine) Mode() Mode { return e.mode }

// Session is the grant set this engine consults, for a caller recording an
// approval answer.
func (e *Engine) Session() *Session { return e.session }

// Evaluate decides one call.
func (e *Engine) Evaluate(c Call) Decision {
	// Path scoping first, and in every mode including Auto. This is the
	// containment check restated as policy: workspace.Resolve is what
	// actually enforces it inside each tool, but catching an out-of-root
	// path here means the approval card never asks the user to bless a
	// write that would have failed anyway.
	if c.Risk == tools.RiskRead {
		if p, ok := pathArg(c.Input); ok && e.ws != nil {
			if _, err := e.ws.ResolveReadable(p); err != nil {
				return refuse(fmt.Sprintf("%q is outside the workspace and read-only roots", p))
			}
		}
	} else if c.Risk == tools.RiskWrite {
		if p, ok := pathArg(c.Input); ok && e.ws != nil {
			if _, err := e.ws.Resolve(p); err != nil {
				return refuse(fmt.Sprintf("%q is outside the workspace", p))
			}
		}
	}

	// A pure read is never gated. This is the property that makes
	// Interactive usable at all: an agent reading twenty files to answer a
	// question must not produce twenty prompts.
	if !c.Risk.Consequential() {
		return allow("read-only")
	}

	// Workspace trust gates every consequential risk, in every mode
	// including Auto -- see docs/coding-agent-parity/
	// 01-workspace-trust-and-rules.md. This has to sit ahead of the mode
	// branches below, not inside them: Auto's unconditional allow and the
	// RiskExternal carve-out further down would otherwise let a model
	// route around an ungranted root just by trying a different mode or
	// risk class. Mode controls how much the agent may do once trusted; it
	// is not itself the trust gesture.
	if !e.trusted {
		return refuse(fmt.Sprintf(
			"this workspace has not been granted trust, so %s (%s) was not run. The user must grant trust to this project (see workspace-trust settings) before the agent can write, run commands, or reach external systems here.",
			c.Tool, c.Risk))
	}

	if e.mode == ModePlan {
		return refuse(fmt.Sprintf(
			"plan mode is read-only, so %s (%s) was not run. Finish exploring and describe what you would change; the user can switch modes to let you make it.",
			c.Tool, c.Risk))
	}

	// AlwaysAsk sits ahead of every mode shortcut below it, including
	// Auto's unconditional allow and RiskExternal's Interactive/Edit
	// allow-without-asking carve-out -- the one place this plan overrides
	// Auto mode's "runs everything without asking" rule. It also does not
	// consult the session's remembered "always allow" grants further down:
	// an AlwaysAsk call is, definitionally, the one thing a prior "always
	// allow" must not silence. See
	// docs/coding-agent-parity/04-git-remote-operations.md.
	if c.AlwaysAsk {
		return ask(fmt.Sprintf("%s writes outside this machine and always asks for approval, in every mode", c.Tool))
	}

	if e.mode == ModeAuto {
		return allow("auto mode")
	}

	// Edit mode automatically allows file modifications (RiskWrite) while
	// continuing to ask for commands and other consequential actions.
	if e.mode == ModeEdit && c.Risk == tools.RiskWrite {
		return allow("edit automatically mode allows file writes")
	}

	// Interactive & Edit mode command gating. External is allowed rather than asked -- see the
	// RiskExternal doc in internal/ai/tools/risk.go for why that hold is
	// deliberate and what would change it.
	if c.Risk == tools.RiskExternal {
		return allow("external calls are not gated yet")
	}

	command := commandOf(c)
	if command != "" {
		if e.commandAllowed(command) {
			return allow("command on the allowlist")
		}
		if e.session.allowsCommand(command) {
			return allow("command approved earlier in this session")
		}
	}

	if e.session.allowsTool(c.Tool) {
		return allow("tool approved earlier in this session")
	}

	if command != "" {
		return ask("run " + command)
	}
	return ask(c.Tool + " needs approval")
}

// commandOf renders a call as a command line, or "" when it has none.
func commandOf(c Call) string {
	if c.CommandLine != nil {
		return strings.TrimSpace(c.CommandLine(c.Input))
	}
	var in struct {
		Command string `json:"command"`
	}
	if err := json.Unmarshal(c.Input, &in); err != nil {
		return ""
	}
	return strings.TrimSpace(in.Command)
}

// pathArg pulls the workspace path a call names, if it names one. Every
// file tool spells it `path`, which is checked by
// TestPathArg_MatchesEveryFileToolSchema.
func pathArg(input json.RawMessage) (string, bool) {
	var in struct {
		Path string `json:"path"`
	}
	if err := json.Unmarshal(input, &in); err != nil {
		return "", false
	}
	if strings.TrimSpace(in.Path) == "" {
		return "", false
	}
	return in.Path, true
}

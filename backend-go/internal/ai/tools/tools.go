// Package tools ports lib/ai/tools/tool-kit.ts's APP_DEFAULT_TOOL_KIT: the
// fixed set of built-in tools every chat request can opt into via
// allowedAppDefaultToolkit, independent of any per-user MCP server config.
// Names and toolkit groupings match DefaultToolName/AppDefaultToolkit
// (lib/ai/tools/index.ts) exactly so a request built by the frontend
// needs no changes at all.
package tools

import (
	"context"
	"encoding/json"

	"amiro/backend/internal/agent/lsp"
	"amiro/backend/internal/agent/memory"
	"amiro/backend/internal/agent/workspace"
	"amiro/backend/internal/db/repository"
	"amiro/backend/internal/skills"
)

// Toolkit names, matching AppDefaultToolkit's string values exactly.
const (
	ToolkitVisualization = "visualization"
	ToolkitWebSearch     = "webSearch"
	ToolkitHttp          = "http"
	ToolkitTerminal      = "terminal"
	ToolkitCode          = "terminal" // backwards-compatible alias
	ToolkitFile          = "file"
	ToolkitTodo          = "todo"
	ToolkitTask          = "task"
	ToolkitMemory        = "memory"
	ToolkitSkill         = "skill"
)

// Tool names, matching DefaultToolName's string values.
const (
	NameCreatePieChart    = "createPieChart"
	NameCreateBarChart    = "createBarChart"
	NameCreateLineChart   = "createLineChart"
	NameCreateTable       = "createTable"
	NameWebSearch         = "webSearch"
	NameWebContent        = "webContent"
	NameHttp              = "http"
	NameTerminalExecution = "terminal-execution"
	NameRunShell          = "run_shell"
	NameShellTaskOutput   = "shell_task_output"
	NameShellTaskKill     = "shell_task_kill"
	NameSkill             = "skill"

	// File ACI (docs/agentic-loop-implementation-plan.md, Phase 2). These
	// are only offered when a workspace root is configured -- see Defaults.
	NameReadFile  = "read_file"
	NameListDir   = "list_dir"
	NameWriteFile = "write_file"
	NameGlob      = "glob"
	NameGrep      = "grep"
	NameEditFile  = "edit_file"
	NameMultiEdit = "multi_edit"
	NameGit       = "git"

	// Orientation and symbol intelligence (Phase 4 item 4 / Phase 5).
	// repo_map always exists with a workspace; lsp only when a language
	// server for a language this workspace actually uses is installed.
	NameRepoMap = "repo_map"
	NameLSP     = "lsp"

	// Plan tracking (Phase 4). Session-scoped, so these only exist when the
	// request carries a conversation id -- see Deps.
	NameTodoWrite = "todo_write"
	NameTodoRead  = "todo_read"

	// Plan review and the end-of-turn summary (Phase 6). propose_plan has no
	// server-side executor on purpose -- it suspends the turn so a human can
	// answer it; see plan.go.
	NameProposePlan = "propose_plan"
	NameWalkthrough = "walkthrough"

	// Durable notes about a workspace (Phase 5). Only offered when both a
	// workspace and an app data directory exist -- see Deps.Memory.
	NameMemoryWrite  = "memory_write"
	NameMemoryRead   = "memory_read"
	NameMemoryForget = "memory_forget"

	// NameTask is the subagent tool. Built in internal/api/chat rather than
	// here -- it needs the engine and the resolved model -- so it never
	// appears in Defaults.
	NameTask = "task"
)

// Concurrency says whether a tool's calls may overlap with other tool calls
// in the same model step. It is *derived* from Risk, never declared -- see
// Definition.Concurrency.
type Concurrency uint8

const (
	// Sequential tools run one at a time, in the order the model emitted
	// them. Anything that writes (files, shell, HTTP verbs other than
	// GET/HEAD) belongs here: ordering is part of their meaning.
	Sequential Concurrency = iota

	// Parallel tools may run concurrently with any other Parallel call in
	// the same step. Their results are still merged back in the model's
	// original call order, so history stays deterministic regardless of
	// which finishes first.
	Parallel
)

// Definition is one callable tool: its wire schema (Name/Description/
// ParametersSchema, handed to Bifrost as a ChatTool) plus how to run it.
type Definition struct {
	Name             string
	Toolkit          string
	Description      string
	ParametersSchema json.RawMessage
	Execute          func(ctx context.Context, input json.RawMessage) (any, error)

	// Risk is the tool's side-effect class. It drives both permission
	// gating and Concurrency below; see risk.go. The zero value
	// (RiskUnclassified) is the restrictive one.
	Risk Risk

	// CommandLine renders a call as the command line the permission
	// engine matches its allowlist against, for tools whose consequential
	// argument is a command rather than a path.
	//
	// nil means "read the input's `command` string field", which covers
	// the shell tools. `git` sets it because its command is spread across
	// a subcommand and an args array, and an allowlist entry of
	// "git status" should match a call the same way it matches a shell
	// invocation -- one allowlist, one matching rule, whatever tool the
	// model reached for.
	CommandLine func(input json.RawMessage) string
}

// Concurrency reports whether this tool's calls may overlap with others in
// the same step.
//
// This used to be a second field every tool declared by hand next to its
// risk, which is one fact written twice: a tool that is safe to run
// concurrently with itself is precisely a tool with no observable side
// effects, and that is precisely RiskRead. OpenWorker's engine.py derives
// it the same way (`risk_level == "low" and not requires_approval`), and
// the parity doc called this out as the better design. Deriving it means a
// new tool cannot be gated as a write while still running in parallel with
// a read of the file it is about to change.
//
// The cost is real and worth naming: RiskExternal tools serialize, so three
// `http` GETs that used to overlap now queue. Risk is static per definition
// and `http` lets the model choose the method and body, so there is no
// honest way to call it side-effect-free -- and ordering between two calls
// that may both mutate remote state is part of their meaning.
func (d Definition) Concurrency() Concurrency {
	if d.Risk == RiskRead {
		return Parallel
	}
	return Sequential
}

// Deps carries the stateful backends the built-in toolset needs.
//
// Constructed once per request (or per turn) and passed to Defaults. A nil
// field means "that tool cannot run", matching how the tool definitions
// themselves handle a missing dependency: the corresponding Definition is
// omitted from Defaults rather than registered with an executor that fails
// on first call.
//
// Why this is not a package-level registry: tests construct isolated
// workspaces, todos stores, and memory pools per test and run them in
// parallel. Global tool instances would share those backends and race.
//
// The rule: every tool with state takes its backend from here; tools with
// no state (createPieChart, http) take nothing. New dependencies are
// optional in the same way -- absent means "that toolkit is not offered
// this turn", never "substitute a default". A tool that quietly falls back
// to the process working directory, or to a shared global list, is worse
// than a tool that is not there.
type Deps struct {
	// Workspace roots the file, search, edit and git tools. Nil omits them
	// entirely rather than falling back to some default directory: "no root
	// configured" must mean "no filesystem access", never "the process's
	// working directory", which on the packaged desktop app is wherever the
	// shell happened to launch the sidecar.
	Workspace *workspace.Workspace

	// ReadOnlyRoots are additional directories (such as active skills) that
	// file, search and repomap tools can read without permitting mutations.
	ReadOnlyRoots []string

	// DiscoveredSkills is the set of skills discovered for the request.
	// When non-empty, the skill() tool is registered.
	DiscoveredSkills []skills.Skill

	// OnActivateSkill is called when the skill tool successfully executes.
	OnActivateSkill func(s *skills.Skill)

	// ActivatedSkills tracks skills already activated in this turn.
	ActivatedSkills *ActivationSet

	// Todos and SessionID together enable the plan tools. The session is
	// supplied by the caller and never appears in a tool's parameters --
	// a tool the model can point at a conversation id is a tool that can
	// read another conversation's state by guessing one.
	Todos     *TodoStore
	SessionID string

	// Memory holds durable notes about this workspace, surviving across
	// conversations. Nil omits the memory tools -- and, importantly, means
	// the system prompt carries no notes either, so the two halves of the
	// feature are never half-present.
	Memory *memory.Store

	// LSP is a pool of running language servers, or nil when none is
	// installed for a language this workspace uses. Nil is the common case
	// and costs nothing: the `lsp` tool is simply never offered, and the
	// model is never told about a tool that would fail on first call.
	LSP *lsp.Pool

	// SearchRepo is the DB repository for retrieving the configured search provider.
	SearchRepo *repository.SearchProviderRepository
}

// Defaults returns every APP_DEFAULT_TOOL_KIT tool, freshly constructed per call.
func Defaults(d Deps) []Definition {
	ws := d.Workspace
	if ws != nil && len(d.ReadOnlyRoots) > 0 {
		ws.AddReadOnlyRoots(d.ReadOnlyRoots...)
	}
	defs := append(append(visualizationTools(), httpFetchTool()), webSearchTools(d.SearchRepo)...)
	defs = append(defs, terminalTools(ws)...)
	defs = append(defs, fileTools(ws)...)
	defs = append(defs, searchTools(ws)...)
	defs = append(defs, editTools(ws)...)
	if ws != nil {
		defs = append(defs, gitTool(ws))
		defs = append(defs, repoMapTool(ws))
		if tool, ok := lspTool(d.LSP, ws); ok {
			defs = append(defs, tool)
		}
	}
	defs = append(defs, todoTools(d.Todos, d.SessionID)...)
	// Unlike the todo tools, these need no session store: propose_plan's
	// answer arrives as its own tool result and the walkthrough is a
	// one-shot summary, so both are stateless and always available.
	defs = append(defs, planTools(ws)...)
	defs = append(defs, memoryTools(d.Memory, d.SessionID)...)
	if skTool, ok := skillTool(d.DiscoveredSkills, d.OnActivateSkill, d.ActivatedSkills); ok {
		defs = append(defs, skTool)
	}
	return defs
}

// alwaysOffered are toolkits the per-request allowlist does not govern.
//
// The allowlist is a *user-facing capability* switch -- "may this agent
// search the web / run commands / touch files" -- and the plan tools are
// not a capability in that sense. They are the agent's own bookkeeping:
// session-scoped, RiskSession, visible only as a checklist in the work log,
// and useless to turn off. Leaving them subject to the allowlist meant they
// were silently dropped from every real request, because the frontend
// always sends an explicit list and no UI ever put "todo" on it. The tools
// existed, the tests passed, and the model was never offered them.
//
// Deliberately not extended to `memory`: a durable note that changes the
// agent's behaviour in future conversations is exactly the kind of thing a
// user should be able to switch off, so it is a real toolkit with a real
// toggle. `task` needs no entry because route.go appends it after this
// filter runs, over whatever tools survived.
var alwaysOffered = map[string]bool{
	ToolkitTodo:  true,
	ToolkitSkill: true,
}

// Filter ports loadAppDefaultTools' selection logic:
func Filter(defs []Definition, allowedToolkits *[]string, defaultToolNames []string) []Definition {
	if len(defaultToolNames) > 0 {
		wanted := make(map[string]bool, len(defaultToolNames))
		for _, n := range defaultToolNames {
			wanted[n] = true
		}
		out := make([]Definition, 0, len(defaultToolNames))
		for _, d := range defs {
			if wanted[d.Name] || alwaysOffered[d.Toolkit] {
				out = append(out, d)
			}
		}
		return out
	}

	var allowed map[string]bool
	if allowedToolkits != nil {
		allowed = make(map[string]bool, len(*allowedToolkits))
		for _, k := range *allowedToolkits {
			allowed[k] = true
		}
	}

	out := make([]Definition, 0, len(defs))
	for _, d := range defs {
		if allowed == nil || alwaysOffered[d.Toolkit] || allowed[d.Toolkit] || (d.Toolkit == ToolkitTerminal && allowed["code"]) {
			out = append(out, d)
		}
	}
	return out
}

// FindByName returns the first definition whose Name matches.
func FindByName(defs []Definition, name string) (Definition, bool) {
	for _, d := range defs {
		if d.Name == name {
			return d, true
		}
	}
	return Definition{}, false
}

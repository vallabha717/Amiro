package tools

import (
	"context"
	"encoding/json"
	"fmt"
	"strings"
	"sync"

	"amiro/backend/internal/agent/workspace"
)

// maxPlanChars bounds one proposed plan.
//
// A plan is a document a human reads before agreeing to it, and one longer
// than this is not being read -- it is being clicked past, which defeats the
// entire point of asking. The bound is on the markdown rather than on a step
// count because the plan is prose: the model can spend it on three deeply
// argued phases or twelve shallow ones, and either can be the right shape.
const maxPlanChars = 24000

// maxWalkthroughChanges bounds the file list in one walkthrough, for the
// same reason maxTodoItems bounds a plan: past this it stops being a reading
// order and becomes a directory listing, which the user could already get.
const maxWalkthroughChanges = 60

/* ------------------------------------------------------------------ */
/* propose_plan                                                        */
/* ------------------------------------------------------------------ */

// PlanProposal is what the model submits. It is never executed server-side
// -- see planTools -- so this type exists to validate the shape the frontend
// will render, not to produce a result.
type PlanProposal struct {
	Title string `json:"title"`
	Plan  string `json:"plan"`
}

// planDecision is what the browser writes back where the tool's output goes.
// Mirrors PlanDecision in src/components/artifacts/use-artifacts.ts.
//
// Declared here and not used by any Go code on purpose: it is the contract
// the model reads, and the description below promises its shape. A reader
// changing one side needs to find the other, and a type is easier to find
// than a sentence inside a prompt string.
type planDecision struct {
	Decision    string        `json:"decision"` // "proceed" | "revise"
	GrantedMode string        `json:"grantedMode,omitempty"`
	Comments    []planComment `json:"comments,omitempty"`
}

type planComment struct {
	Section string `json:"section,omitempty"`
	Quote   string `json:"quote"`
	Note    string `json:"note"`
}

const proposePlanDescription = `Submit an implementation plan for the user to review before you change anything.

Write the plan as markdown: headings, prose, and tables are all fine, and a table of the files you intend to touch and why is usually the most useful thing in it. Say what you will change and why, not what you looked at.

This tool stops your turn. The user reads the plan, may attach comments to any part of it, and answers:

  {"decision":"proceed"}  -- start the work. Write a todo list first, then execute the plan you just had approved.
  {"decision":"revise", "comments":[{"quote":"...","note":"..."}]}  -- do NOT start work. Each comment quotes the part of the plan it is about. Address every one of them, then call propose_plan again with the revised plan.

The user cannot edit the plan themselves; comments are the only thing they can send back, so every objection arrives as one and every one of them is yours to resolve.`

// proposePlanTool is the propose-plan-then-approve contract.
//
// It has no Execute, and that is the entire mechanism rather than an
// omission. A tool with a nil executor is left in "input-available" by the
// scheduler, which stops the loop and hands the call to the browser -- the
// same rail client-executed tools and approval prompts already ride
// (tool_scheduler.go). The user's answer arrives as the tool's result and
// the turn resumes from exactly this call.
//
// Routing it through the permission engine instead was the obvious
// alternative and is wrong: "a human must sign off on this document" is a
// property of this one tool, not a risk class, and Risk is what decides
// whether *any* tool may run. Making the engine special-case a tool name
// would put a UI contract inside the thing that decides what the agent is
// allowed to do.
func proposePlanTool() Definition {
	return Definition{
		Name:    NameProposePlan,
		Toolkit: ToolkitTodo,
		// Session risk: proposing a plan changes nothing outside this
		// conversation. The pause is not a permission gate and must not be
		// mistaken for one -- a plan the user rejects has still cost nothing.
		Risk:        RiskSession,
		Description: proposePlanDescription,
		ParametersSchema: json.RawMessage(`{
			"type": "object",
			"properties": {
				"title": {
					"type": "string",
					"description": "A short name for the plan, one line."
				},
				"plan": {
					"type": "string",
					"description": "The plan itself, as markdown. Headings, prose, lists and tables."
				}
			},
			"required": ["title", "plan"],
			"additionalProperties": false
		}`),
		// Execute is deliberately nil. See the doc comment.
		Execute: nil,
	}
}

// ValidatePlanProposal reports what is wrong with a proposal, if anything.
//
// The scheduler never calls this -- there is no executor to call it from --
// so it exists for the tests and for any future caller that wants to check a
// proposal before it reaches the browser. Keeping the rule here rather than
// only in the frontend means the two cannot disagree about what an empty
// plan is.
func ValidatePlanProposal(raw json.RawMessage) (PlanProposal, error) {
	var p PlanProposal
	if err := json.Unmarshal(raw, &p); err != nil {
		return PlanProposal{}, fmt.Errorf("%s: %w", NameProposePlan, err)
	}
	p.Title = strings.TrimSpace(p.Title)
	p.Plan = strings.TrimSpace(p.Plan)
	if p.Plan == "" {
		return PlanProposal{}, fmt.Errorf("%s: the plan is empty -- describe what you intend to change and why", NameProposePlan)
	}
	if len(p.Plan) > maxPlanChars {
		return PlanProposal{}, fmt.Errorf("%s: the plan is %d characters, over the %d limit -- a plan this long will not be read, so cut it to the decisions",
			NameProposePlan, len(p.Plan), maxPlanChars)
	}
	if p.Title == "" {
		// Recovered rather than rejected: the title is a label on a panel,
		// and refusing an otherwise-good plan over a missing one would throw
		// away the work for a cosmetic field.
		p.Title = "Implementation plan"
	}
	return p, nil
}

/* ------------------------------------------------------------------ */
/* walkthrough                                                         */
/* ------------------------------------------------------------------ */

// WalkthroughChange is one file, and why a reader should open it.
type WalkthroughChange struct {
	Path string `json:"path"`
	Why  string `json:"why"`
}

// WalkthroughRecord holds the most recent Walkthrough this turn produced,
// shared between walkthroughTool's Execute (the writer) and createPRTool's
// (the reader) -- the same "small mutable struct threaded through Deps"
// shape ActivationSet already established for the skill tool, not a new
// mechanism.
//
// It is deliberately not a verification ledger: it does not check the
// walkthrough against what the turn actually edited (see walkthroughTool's
// own doc comment for why that check, while real, does not belong here).
// It only answers "did this turn call walkthrough, and what did it say" --
// the fact create_pr needs to refuse opening a PR with no real description
// rather than inventing one.
type WalkthroughRecord struct {
	mu  sync.Mutex
	val *Walkthrough
}

// NewWalkthroughRecord returns an empty record -- one per turn, the same
// lifetime as ActivationSet.
func NewWalkthroughRecord() *WalkthroughRecord { return &WalkthroughRecord{} }

// Set stores w as the turn's latest walkthrough.
func (r *WalkthroughRecord) Set(w Walkthrough) {
	if r == nil {
		return
	}
	r.mu.Lock()
	defer r.mu.Unlock()
	cp := w
	r.val = &cp
}

// Get returns the turn's walkthrough, if one has been recorded yet.
func (r *WalkthroughRecord) Get() (Walkthrough, bool) {
	if r == nil || r.val == nil {
		return Walkthrough{}, false
	}
	r.mu.Lock()
	defer r.mu.Unlock()
	return *r.val, true
}

// Walkthrough is the end-of-turn summary: what changed, in reading order.
type Walkthrough struct {
	Summary   string              `json:"summary"`
	Changes   []WalkthroughChange `json:"changes"`
	Testing   string              `json:"testing,omitempty"`
	FollowUps []string            `json:"follow_ups,omitempty"`
	Notice    string              `json:"notice,omitempty"`
}

const walkthroughDescription = `Summarize what you changed, once the work is done.

Call this at the end of a turn that modified files. List the files in READING ORDER -- the order someone reviewing this should open them, which is usually the core change first and the mechanical follow-on edits after, not the order you happened to edit them. For each one, say why it changed, not what the diff shows.

Do not call this for a turn that only read or searched; there is nothing to walk through.`

// walkthroughTool builds the end-of-turn summary tool.
//
// It has a real executor, unlike propose_plan, because nothing is being
// asked of the user here -- the walkthrough is an artifact the turn produces,
// not a question it stops on.
//
// What the executor deliberately does *not* do is check the summary against
// what the turn actually edited. That check is real and worth having, but
// the data for it (this turn's edit_file/write_file/multi_edit calls) lives
// in the message parts the frontend already holds, and reproducing it here
// would mean a per-session ledger of edited paths maintained by the write
// tools -- new mutable state, kept in sync by hand, for a check that can be
// done from data that already exists. The presenter does it instead.
func walkthroughTool(ws *workspace.Workspace, rec *WalkthroughRecord) Definition {
	return Definition{
		Name:    NameWalkthrough,
		Toolkit: ToolkitTodo,
		// Session, for the same reason as the todo tools: it records what the
		// agent did, and gating a summary would put an approval card between
		// the user and the explanation of the work they already approved.
		Risk:        RiskSession,
		Description: walkthroughDescription,
		ParametersSchema: json.RawMessage(`{
			"type": "object",
			"properties": {
				"summary": {
					"type": "string",
					"description": "A short paragraph: what this turn accomplished."
				},
				"changes": {
					"type": "array",
					"description": "The files you changed, in the order someone should read them.",
					"items": {
						"type": "object",
						"properties": {
							"path": {"type": "string", "description": "Path to the file."},
							"why": {"type": "string", "description": "Why it changed -- the reason, not the diff."}
						},
						"required": ["path", "why"],
						"additionalProperties": false
					}
				},
				"testing": {
					"type": "string",
					"description": "How to verify this: the command to run, or what to click."
				},
				"follow_ups": {
					"type": "array",
					"description": "Anything left undone, and why.",
					"items": {"type": "string"}
				}
			},
			"required": ["summary", "changes"],
			"additionalProperties": false
		}`),
		Execute: func(ctx context.Context, raw json.RawMessage) (any, error) {
			var in Walkthrough
			if err := json.Unmarshal(raw, &in); err != nil {
				return nil, fmt.Errorf("%s: %w", NameWalkthrough, err)
			}

			in.Summary = strings.TrimSpace(in.Summary)
			if in.Summary == "" {
				return nil, fmt.Errorf("%s: the summary is empty -- say what this turn accomplished", NameWalkthrough)
			}

			if len(in.Changes) > maxWalkthroughChanges {
				return nil, fmt.Errorf("%s: %d files, over the %d limit -- summarize the mechanical ones as a group",
					NameWalkthrough, len(in.Changes), maxWalkthroughChanges)
			}

			cleaned := make([]WalkthroughChange, 0, len(in.Changes))
			for _, c := range in.Changes {
				path := strings.TrimSpace(c.Path)
				if path == "" {
					continue
				}
				cleaned = append(cleaned, WalkthroughChange{
					Path: displayPath(ws, path),
					Why:  strings.TrimSpace(c.Why),
				})
			}
			in.Changes = cleaned

			follow := make([]string, 0, len(in.FollowUps))
			for _, f := range in.FollowUps {
				if f = strings.TrimSpace(f); f != "" {
					follow = append(follow, f)
				}
			}
			in.FollowUps = follow
			in.Testing = strings.TrimSpace(in.Testing)

			// A warning rather than an error: a walkthrough with no files is
			// odd but not wrong (a turn may have only run commands), and
			// rejecting it would lose a summary the user can still read.
			if len(in.Changes) == 0 {
				in.Notice = "no files listed -- if this turn changed something, say which file"
			}
			rec.Set(in)
			return in, nil
		},
	}
}

// displayPath renders a path the way the user sees it in every other tool
// result: relative to the workspace root when it is inside one.
//
// Failure is not an error here. The walkthrough is prose about work that has
// already happened, and a path the model wrote slightly wrong (or one that
// genuinely sits outside the root, like a note about a system config file)
// should appear as written rather than fail the whole summary. Contrast the
// write tools, where an unresolvable path means refusing to act.
func displayPath(ws *workspace.Workspace, p string) string {
	if ws == nil {
		return p
	}
	abs, err := ws.Resolve(p)
	if err != nil {
		return p
	}
	rel, err := ws.Rel(abs)
	if err != nil {
		return p
	}
	return rel
}

/* ------------------------------------------------------------------ */

// planTools returns the plan-review and walkthrough tools.
//
// Both live in ToolkitTodo, which Filter exempts from the per-request
// allowlist (see alwaysOffered). The reasoning that put the todo tools there
// applies unchanged: these are how the agent coordinates with the user about
// its own work, not a capability like "may search the web" that a user would
// think to switch on. A propose_plan the frontend forgot to allowlist would
// be a Plan mode that silently never proposes anything -- exactly the bug
// that hid the todo tools for a whole phase.
func planTools(ws *workspace.Workspace, rec *WalkthroughRecord) []Definition {
	return []Definition{proposePlanTool(), walkthroughTool(ws, rec)}
}

package tools

// Risk is a tool's intrinsic side-effect class -- the single declared
// property everything else about gating and scheduling is derived from.
//
// It exists because the alternative, which this file replaced, was a set of
// hand-maintained name lists ("these tools write", "this one is the shell")
// that each new tool had to be added to, in a different file from the tool
// itself, by someone who remembered all of them. OpenWorker's risk.py made
// the same move for the same reason.
//
// Two consumers read it and they must not disagree:
//
//   - The permission engine (internal/agent/permission) decides allow /
//     deny / ask from the risk class plus the active mode.
//   - Definition.Concurrency derives whether calls may overlap. A tool that
//     is safe to run twice at once is one whose calls commute, which is
//     exactly RiskRead -- so concurrency is not a second thing to declare,
//     it is a consequence of the first.
//
// The two consumers ask different questions -- "who else is affected?" and
// "does this commute with itself?" -- which happen to have the same answer
// for every class but RiskSession.
type Risk uint8

const (
	// RiskUnclassified is the zero value, and is deliberately the most
	// restrictive: a tool nobody classified is treated as consequential
	// (needs approval) and never runs in parallel. Forgetting to declare a
	// risk therefore costs an approval prompt, never a silent hole.
	//
	// TestDefaults_EveryToolDeclaresRisk asserts no built-in tool ships in
	// this state; it exists for dynamically-loaded definitions whose
	// provenance we genuinely cannot vouch for.
	RiskUnclassified Risk = iota

	// RiskRead has no observable side effects: reading a file, listing a
	// directory, searching, rendering a chart from data the model already
	// has. Always allowed, always parallel-safe.
	RiskRead

	// RiskSession mutates the agent's own bookkeeping and nothing else --
	// the todo list, and anything like it. It is *not* consequential (no
	// prompt: an agent revising its plan eight times must not produce eight
	// approval cards, which would make the feature unusable and train the
	// user to click yes without reading) but it is *not* parallel-safe
	// either (two writes to one list race, and last-write-wins silently
	// drops half the plan).
	//
	// This is the class that forced Consequential and Concurrency apart.
	// They agreed for read/write/exec/external, which made it tempting to
	// treat "needs approval" and "must not overlap" as one question. They
	// are two: the first is about who is affected, the second about whether
	// the operation commutes with itself.
	RiskSession

	// RiskWrite mutates the local workspace. Path-scoped in every mode and
	// approval-gated outside Auto.
	RiskWrite

	// RiskExec runs commands. Distinct from RiskWrite because a command's
	// blast radius is not described by its arguments -- there is no path to
	// scope, so the command-prefix allowlist is the only lever, and it has
	// to reason about shell metacharacters that a write never involves.
	RiskExec

	// RiskExternal has side effects off this machine: an HTTP request the
	// model chose the method and body for, an MCP tool that posts to a
	// third-party API. Denied in read-only modes.
	//
	// Interactive mode currently *allows* External rather than asking. That
	// is a deliberate hold, not an oversight: every MCP tool is External,
	// MCP servers are already user-configured and per-tool toggleable in
	// settings, and prompting for each of them would make the feature
	// unusable while adding little -- the user already chose to connect the
	// server. Routing External to a considered approval (per-connector,
	// per-target, rememberable) is the Inbox work in Tier 2 of the parity
	// doc. Classifying it now is what makes that change a policy edit
	// rather than another audit of every tool.
	RiskExternal
)

func (r Risk) String() string {
	switch r {
	case RiskRead:
		return "read"
	case RiskSession:
		return "session"
	case RiskWrite:
		return "write"
	case RiskExec:
		return "exec"
	case RiskExternal:
		return "external"
	default:
		return "unclassified"
	}
}

// Consequential reports whether a call needs the permission engine's
// attention at all -- whether anyone but the agent is affected by it.
//
// Deliberately not the same predicate as Definition.Concurrency, even
// though the two agree for every class but RiskSession. See RiskSession.
func (r Risk) Consequential() bool { return r != RiskRead && r != RiskSession }

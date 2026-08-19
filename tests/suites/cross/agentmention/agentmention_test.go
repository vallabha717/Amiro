// Package agentmention_test proves Phase 7's second cross-surface journey,
// quoted verbatim from the Section 1 table of
// docs/testing/phases/phase-07-cross-surface.md:
//
//	| UI → TUI | Create an agent in the browser; `@`-completion in the TUI offers it |
//
// and contributes to Exit Criterion 1, quoted verbatim: "`amirotest run
// --surface cross` passes, and every cross-surface journey above has a
// test."
//
// WHAT PLAYS "THE BROWSER", AND WHY THAT IS FAITHFUL.
// "The browser" is a second apiclient.Client (h.As("admin")) doing exactly
// what the dashboard's agent editor does: POST /api/agent. `cross` is a
// Go-test surface, so there is no DOM to click; but the agent row the
// dashboard would create and the agent row this creates are the same row in
// the same database, and that shared row is the whole claim. The TUI half
// is NOT substituted: this drives the real `amiro` binary under a real PTY,
// types a real "@" prefix, and reads the completion popup off the rendered
// terminal frame (component/editor.RenderMentionSuggestions' "@name  help"
// line), so the completion path is proven end to end, pixels included.
//
// LOAD-BEARING, VERIFIED ASSUMPTION -- ORDERING MATTERS.
// internal/tui/page/mentions.go loads the mentionable list ONCE, at startup
// (page.Chat.Init returns tea.Batch(textarea.Blink, m.loadMentionables), and
// the only thing that sets m.mentionCandidates is mentionablesLoadedMsg).
// There is no refetch on "@" and no server push. So an agent created while
// a TUI is already running is NOT offered by that running TUI until it is
// restarted. The journey row makes no "without a restart" claim -- unlike
// the TUI → UI row directly above it, which does -- so the faithful reading
// is create-then-launch, and that is what this test asserts. The staleness
// limitation is stated here rather than left implicit, because a reader
// would otherwise reasonably assume the stronger property.
package agentmention_test

import (
	"context"
	"strings"
	"testing"
	"time"

	"amiro/tests/harness"
	"amiro/tests/harness/apiclient"
	"amiro/tests/harness/pty"
)

func TestCrossSurface_AgentCreatedInTheDashboardIsOfferedByTUIMentionCompletion(t *testing.T) {
	// Deliberately not a substring of any DefaultToolMentions entry, so a
	// match in the popup can only have come from the agent row.
	const agentName = "crossbrowseragent"

	h := harness.New(t, harness.Tags("smoke"))
	be := h.Backend()

	// harness.PTY signs the TUI in as the seeded "admin" identity (it writes
	// that identity's token into keys.json under "amiro:session"), so the
	// browser-side client has to be the same user for the agent to be one of
	// GET /api/agent's rows for the TUI.
	browser := h.As("admin")
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()

	desc := "created through the dashboard's API, offered by the TUI"
	agent, err := browser.CreateAgent(ctx, apiclient.AgentInput{
		Name:        agentName,
		Description: &desc,
		Visibility:  "private",
	})
	if err != nil {
		t.Fatalf("creating the agent from the browser-side client: %v", err)
	}
	if agent.Name != agentName {
		t.Fatalf("the API stored the agent as %q, not %q; the TUI would complete against the stored name",
			agent.Name, agentName)
	}

	sess := h.PTY(
		harness.PTYAppDataDir(be.AppDataDir),
		harness.PTYDir(be.WorkspaceRoot),
		harness.PTYDims(180, 60),
	)
	defer sess.Close()

	if err := sess.WaitForText("Ask Amiro", 15*time.Second); err != nil {
		t.Fatalf("the TUI did not render its prompt: %v\nframe:\n%s", err, sess.Frame())
	}

	// A prefix, not the whole name: this has to exercise SuggestMentions'
	// prefix filter rather than just echoing back what was typed.
	if err := sess.Send("@crossbrowser"); err != nil {
		t.Fatalf("typing the mention prefix: %v", err)
	}

	// The asserted string is the WHOLE popup row -- "@" + Name + "  " + Help,
	// exactly editor.RenderMentionSuggestions' format with Help "agent" from
	// editor.AgentMention. Matching the row rather than just the name is what
	// separates "the completion list offered the agent" from "the composer
	// echoed back the characters that were typed".
	want := "@" + agentName + "  agent"
	if err := sess.WaitForFrame(func(b *pty.Buffer) bool {
		return strings.Contains(unwrapped(b.Plain()), want)
	}, 10*time.Second); err != nil {
		t.Fatalf("the TUI's @-completion never offered the agent %q that was created through the dashboard "+
			"(looked for the popup row %q): %v\nframe:\n%s", agentName, want, err, sess.Frame())
	}
}

// unwrapped joins a rendered frame's lines back together, undoing the
// terminal's own hard wrap at the right margin.
//
// This is needed, and is not a weakening of the assertion. The completion
// popup is drawn at whatever column the composer left the cursor on, so at
// the harness's terminal width the row lands a few columns short of the
// right margin and the terminal wraps it -- the observed frame reads
// "@cross" / "browseragent  agent" across two lines. A wrap continuation
// always resumes at column 0 and the preceding line is full to the margin
// (pty.Buffer.Plain only trims trailing spaces, and a wrapped line has
// none), so concatenating adjacent lines is exactly the inverse of the
// wrap. The string being searched for is long and specific enough that it
// cannot be assembled by accident out of two unrelated rows.
func unwrapped(frame string) string {
	return strings.ReplaceAll(frame, "\n", "")
}

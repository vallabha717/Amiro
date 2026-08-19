package tools

import (
	"context"
	"encoding/json"
	"strings"
	"testing"
)

// walkthroughRunner runs the walkthrough tool with no workspace, which is
// the case where paths pass through as written.
func walkthroughRunner(t *testing.T) func(string) (Walkthrough, error) {
	t.Helper()
	d, ok := FindByName(Defaults(Deps{}), NameWalkthrough)
	if !ok {
		t.Fatal("walkthrough is not offered")
	}
	return func(raw string) (Walkthrough, error) {
		out, err := d.Execute(context.Background(), json.RawMessage(raw))
		if err != nil {
			return Walkthrough{}, err
		}
		w, ok := out.(Walkthrough)
		if !ok {
			t.Fatalf("got %T, want Walkthrough", out)
		}
		return w, nil
	}
}

/* ------------------------------------------------------------------ */
/* propose_plan                                                        */
/* ------------------------------------------------------------------ */

// The nil executor is the entire mechanism, so it gets its own assertion
// rather than only being covered by the general "every tool has Execute"
// exception. Someone filling this in would not break a build or a type
// check -- the turn would simply stop pausing, the plan would never reach a
// human, and Plan mode would silently go back to being a mode that refuses
// writes and nothing else.
func TestProposePlan_HasNoServerExecutor(t *testing.T) {
	d, ok := FindByName(Defaults(Deps{}), NameProposePlan)
	if !ok {
		t.Fatal("propose_plan is not offered")
	}
	if d.Execute != nil {
		t.Fatal("propose_plan has an executor; the nil one is what suspends the turn for a human to answer")
	}
	if d.Risk != RiskSession {
		t.Fatalf("propose_plan risk is %s, want session -- proposing a plan changes nothing outside the conversation", d.Risk)
	}
}

func TestValidatePlanProposal_RejectsAnEmptyPlan(t *testing.T) {
	for _, raw := range []string{
		`{"title":"Do the thing","plan":""}`,
		`{"title":"Do the thing","plan":"   \n  "}`,
	} {
		if _, err := ValidatePlanProposal(json.RawMessage(raw)); err == nil {
			t.Fatalf("accepted an empty plan: %s", raw)
		}
	}
}

// A title is cosmetic -- it labels a panel. Rejecting an otherwise-complete
// plan over it would throw away the exploration that produced it.
func TestValidatePlanProposal_RecoversAMissingTitle(t *testing.T) {
	p, err := ValidatePlanProposal(json.RawMessage(`{"plan":"## Phase 1\nDo the thing."}`))
	if err != nil {
		t.Fatalf("rejected a plan with no title: %v", err)
	}
	if p.Title == "" {
		t.Fatal("title is still empty; it labels the artifact panel and cannot be blank")
	}
}

func TestValidatePlanProposal_RejectsAPlanNobodyWouldRead(t *testing.T) {
	huge := strings.Repeat("a", maxPlanChars+1)
	_, err := ValidatePlanProposal(json.RawMessage(`{"title":"t","plan":"` + huge + `"}`))
	if err == nil {
		t.Fatal("accepted a plan over the character limit")
	}
	if !strings.Contains(err.Error(), NameProposePlan) {
		t.Fatalf("error %q does not name the tool; classifyToolError reads that prefix to tell a refusal from a crash", err)
	}
}

// Markdown is the plan's format, and tables in particular have to survive
// untouched: the artifact pane anchors comments into them cell by cell.
func TestValidatePlanProposal_KeepsMarkdownVerbatim(t *testing.T) {
	plan := "## Phase 1\n\n| file | change |\n| --- | --- |\n| a.go | add X |\n"
	p, err := ValidatePlanProposal(json.RawMessage(mustJSON(t, PlanProposal{Title: "t", Plan: plan})))
	if err != nil {
		t.Fatalf("rejected a table: %v", err)
	}
	if p.Plan != strings.TrimSpace(plan) {
		t.Fatalf("plan was rewritten:\ngot  %q\nwant %q", p.Plan, strings.TrimSpace(plan))
	}
}

/* ------------------------------------------------------------------ */
/* walkthrough                                                         */
/* ------------------------------------------------------------------ */

func TestWalkthrough_RejectsAnEmptySummary(t *testing.T) {
	run := walkthroughRunner(t)
	if _, err := run(`{"summary":"  ","changes":[{"path":"a.go","why":"x"}]}`); err == nil {
		t.Fatal("accepted a walkthrough with no summary")
	}
}

// A turn can legitimately change nothing on disk -- it may have only run
// commands. That is worth flagging, not worth discarding a summary the user
// can still read.
func TestWalkthrough_NoticesAnEmptyFileListRatherThanFailing(t *testing.T) {
	run := walkthroughRunner(t)
	got, err := run(`{"summary":"Ran the suite.","changes":[]}`)
	if err != nil {
		t.Fatalf("rejected a walkthrough with no files: %v", err)
	}
	if got.Notice == "" {
		t.Fatal("no notice on a walkthrough that lists no files")
	}
}

func TestWalkthrough_DropsBlankEntriesAndTrims(t *testing.T) {
	run := walkthroughRunner(t)
	got, err := run(`{"summary":"s","changes":[{"path":"  ","why":"x"},{"path":" a.go ","why":"  did y  "}],"follow_ups":["  ","real"]}`)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if len(got.Changes) != 1 {
		t.Fatalf("got %d changes, want 1 (the blank path dropped): %+v", len(got.Changes), got.Changes)
	}
	if got.Changes[0].Path != "a.go" || got.Changes[0].Why != "did y" {
		t.Fatalf("not trimmed: %+v", got.Changes[0])
	}
	if len(got.FollowUps) != 1 || got.FollowUps[0] != "real" {
		t.Fatalf("follow-ups not cleaned: %+v", got.FollowUps)
	}
}

func TestWalkthrough_RejectsAListThatIsJustADirectoryDump(t *testing.T) {
	run := walkthroughRunner(t)
	changes := make([]WalkthroughChange, maxWalkthroughChanges+1)
	for i := range changes {
		changes[i] = WalkthroughChange{Path: "f.go", Why: "x"}
	}
	raw := mustJSON(t, Walkthrough{Summary: "s", Changes: changes})
	if _, err := run(raw); err == nil {
		t.Fatalf("accepted %d files, over the %d limit", len(changes), maxWalkthroughChanges)
	}
}

// The walkthrough describes work that already happened, so a path the model
// wrote slightly wrong should still appear rather than fail the summary.
// Contrast the write tools, where an unresolvable path means refusing to act.
func TestWalkthrough_KeepsAPathItCannotResolve(t *testing.T) {
	ws, _ := testWorkspace(t)
	d := walkthroughTool(ws)
	out, err := d.Execute(context.Background(), json.RawMessage(
		`{"summary":"s","changes":[{"path":"/etc/hosts","why":"noted, not edited"}]}`))
	if err != nil {
		t.Fatalf("a path outside the workspace failed the whole summary: %v", err)
	}
	got := out.(Walkthrough)
	if len(got.Changes) != 1 || got.Changes[0].Path == "" {
		t.Fatalf("path was dropped: %+v", got.Changes)
	}
}

func TestWalkthrough_RendersPathsRelativeToTheWorkspace(t *testing.T) {
	ws, root := testWorkspace(t)
	d := walkthroughTool(ws)
	out, err := d.Execute(context.Background(), json.RawMessage(
		mustJSON(t, Walkthrough{
			Summary: "s",
			Changes: []WalkthroughChange{{Path: root + "/pkg/a.go", Why: "core change"}},
		})))
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if got := out.(Walkthrough).Changes[0].Path; got != "pkg/a.go" {
		t.Fatalf("got %q, want %q -- every other tool result names paths relative to the root", got, "pkg/a.go")
	}
}

func mustJSON(t *testing.T, v any) string {
	t.Helper()
	b, err := json.Marshal(v)
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}
	return string(b)
}

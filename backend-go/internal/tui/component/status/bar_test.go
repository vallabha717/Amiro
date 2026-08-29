package status

import (
	"strings"
	"testing"
	"time"

	"github.com/charmbracelet/x/exp/golden"

	"amiro/backend/internal/tui/session"
)

func TestRender_ShowsCostForAKnownModel(t *testing.T) {
	line := Render(200, Info{
		Model:   "openai/gpt-4o",
		Mode:    "interactive",
		Usage:   &session.Usage{PromptTokens: 1000, CompletionTokens: 500, TotalTokens: 1500},
		Elapsed: 3 * time.Second,
	})
	if !strings.Contains(line, "$") {
		t.Fatalf("Render = %q, want a cost field for a model the static pricing fallback knows", line)
	}
	if !strings.Contains(line, "1500 tok") {
		t.Fatalf("Render = %q, want the total token count", line)
	}
}

// TestRender_OmitsCostForAnUnknownModel is the negative case that matters
// most: a model the catalog has never heard of must not show a misleading
// "$0.00" -- that reads as "this is free," not "the catalog doesn't know."
func TestRender_OmitsCostForAnUnknownModel(t *testing.T) {
	line := Render(200, Info{
		Model:   "some-provider/some-model-nobody-has-priced",
		Usage:   &session.Usage{PromptTokens: 1000, CompletionTokens: 500, TotalTokens: 1500},
		Elapsed: time.Second,
	})
	if strings.Contains(line, "$") {
		t.Fatalf("Render = %q, want no cost field for an unpriced model", line)
	}
	if !strings.Contains(line, "1500 tok") {
		t.Fatalf("Render = %q, want the total token count even without a cost", line)
	}
}

func TestRender_OmitsUsageFieldsBeforeAnyTurnFinishes(t *testing.T) {
	line := Render(200, Info{Mode: "interactive", WorkspaceRoot: "/repo", Elapsed: 2 * time.Second})
	if strings.Contains(line, "tok") || strings.Contains(line, "$") {
		t.Fatalf("Render = %q, want no tokens/cost before Usage is set", line)
	}
}

func TestRender_ShowsSkillWhenPresent(t *testing.T) {
	line := Render(200, Info{
		Mode:          "interactive",
		WorkspaceRoot: "/repo",
		Skill:         "summarize",
		Elapsed:       2 * time.Second,
	})
	if !strings.Contains(line, "skill:summarize") {
		t.Fatalf("Render = %q, want 'skill:summarize' in status bar", line)
	}
}

func TestRender_ElapsedFormatsMinutesAndSeconds(t *testing.T) {
	cases := []struct {
		d    time.Duration
		want string
	}{
		{0, "0s"},
		{45 * time.Second, "45s"},
		{60 * time.Second, "1m00s"},
		{90 * time.Second, "1m30s"},
		{125 * time.Second, "2m05s"},
	}
	for _, c := range cases {
		got := formatElapsed(c.d)
		if got != c.want {
			t.Errorf("formatElapsed(%v) = %q, want %q", c.d, got, c.want)
		}
	}
}

// TestRender_DropsMiddleFieldsUnderWidthPressure proves the narrow-terminal
// fallback keeps what a user is watching live (tokens, elapsed) and drops
// everything else, rather than silently truncating or wrapping the line.
func TestRender_DropsMiddleFieldsUnderWidthPressure(t *testing.T) {
	info := Info{
		Model:         "openai/gpt-4o",
		Mode:          "interactive",
		WorkspaceRoot: "/home/user/a/very/long/path/that/eats/a/lot/of/room/in/this/repository",
		Usage:         &session.Usage{PromptTokens: 1000, CompletionTokens: 500, TotalTokens: 1500},
		Elapsed:       7 * time.Second,
		Hint:          "enter to send · ctrl+c to quit",
	}

	wide := Render(300, info)
	if !strings.Contains(wide, "interactive") || !strings.Contains(wide, info.Hint) {
		t.Fatalf("wide Render = %q, want every field present", wide)
	}

	narrow := Render(20, info)
	if strings.Contains(narrow, "interactive") {
		t.Fatalf("narrow Render = %q, want mode dropped under width pressure", narrow)
	}
	if !strings.Contains(narrow, "7s") {
		t.Fatalf("narrow Render = %q, want elapsed to survive width pressure", narrow)
	}
	if !strings.Contains(narrow, "1500 tok") {
		t.Fatalf("narrow Render = %q, want tokens to survive width pressure", narrow)
	}
}

func TestRender_EmptyInfoDoesNotPanic(t *testing.T) {
	_ = Render(0, Info{})
	_ = Render(80, Info{})
}

// TestRender_Golden_SandboxIndicator is exit criterion 4: a golden test in
// this package asserting the sandbox indicator's exact rendering, at each
// value the field can hold ("bubblewrap", "seatbelt", "none", and unset --
// the last proving absence renders no field at all rather than a blank or
// misleading one, the same contract Usage already has). "none" is
// deliberately not hidden or softened -- see Info.Sandbox's doc comment.
func TestRender_Golden_SandboxIndicator(t *testing.T) {
	base := Info{Mode: "interactive", WorkspaceRoot: "/repo", Elapsed: 5 * time.Second}

	for _, name := range []string{"unset", "bubblewrap", "seatbelt", "none"} {
		t.Run(name, func(t *testing.T) {
			info := base
			if name != "unset" {
				info.Sandbox = name
			}
			golden.RequireEqual(t, []byte(Render(120, info)))
		})
	}
}

// TestRender_SandboxDroppedUnderWidthPressure pins that the sandbox field
// is one of the "middle fields" dropped under width pressure (same
// treatment as Mode/WorkspaceRoot/Skill), not one of the two fields
// (elapsed, tokens) the narrow fallback always keeps.
func TestRender_SandboxDroppedUnderWidthPressure(t *testing.T) {
	info := Info{
		Mode:          "interactive",
		WorkspaceRoot: "/home/user/a/very/long/path/that/eats/a/lot/of/room/in/this/repository",
		Sandbox:       "bubblewrap",
		Usage:         &session.Usage{PromptTokens: 1000, CompletionTokens: 500, TotalTokens: 1500},
		Elapsed:       7 * time.Second,
	}

	wide := Render(300, info)
	if !strings.Contains(wide, "sandbox:bubblewrap") {
		t.Fatalf("wide Render = %q, want the sandbox field present", wide)
	}

	narrow := Render(20, info)
	if strings.Contains(narrow, "sandbox:") {
		t.Fatalf("narrow Render = %q, want sandbox dropped under width pressure", narrow)
	}
}

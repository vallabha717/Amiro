package approval

import (
	"strings"
	"testing"

	"amiro/backend/internal/tui/session"
)

func TestRender_CommandShapedCallShowsTheLiteralCommand(t *testing.T) {
	req := session.ApprovalRequest{
		ToolCallID: "call-1", ToolName: "run_shell", Risk: "exec",
		Reason: "run_shell needs approval", Command: "go test ./...",
	}
	out := Render(80, req, []byte(`{"command":"go test ./..."}`))

	if !strings.Contains(out, "Approve run_shell?") {
		t.Fatalf("Render output missing the title: %s", out)
	}
	if !strings.Contains(out, "runs a command") {
		t.Fatalf("Render output missing the risk label: %s", out)
	}
	if !strings.Contains(out, "$ go test ./...") {
		t.Fatalf("Render output missing the literal command: %s", out)
	}
	if !strings.Contains(out, "[y] approve once") || !strings.Contains(out, "[a] always allow") || !strings.Contains(out, "[n] deny") {
		t.Fatalf("Render output missing the y/a/n hint: %s", out)
	}
}

func TestRender_CompoundCommandShowsTheWarning(t *testing.T) {
	req := session.ApprovalRequest{ToolName: "run_shell", Risk: "exec", Command: "go test ./... && rm -rf /", Compound: true}
	out := Render(80, req, nil)
	if !strings.Contains(out, "chains or redirects") {
		t.Fatalf("Render output missing the compound-command warning: %s", out)
	}
}

func TestRender_NonCommandCallFallsBackToInputJSON(t *testing.T) {
	req := session.ApprovalRequest{ToolName: "write_file", Risk: "write"}
	out := Render(80, req, []byte(`{"path":"a.go","content":"package main"}`))
	if !strings.Contains(out, `"path": "a.go"`) {
		t.Fatalf("Render output missing the pretty-printed input, want it as the fallback preview: %s", out)
	}
}

func TestRender_ReasonIsShownWhenPresent(t *testing.T) {
	req := session.ApprovalRequest{ToolName: "run_shell", Reason: "this command is not on the allowlist"}
	out := Render(80, req, nil)
	if !strings.Contains(out, "this command is not on the allowlist") {
		t.Fatalf("Render output missing the reason: %s", out)
	}
}

// TestRender_NeverPanicsOnEmptyOrMalformedInput mirrors toolcard's own
// robustness test -- a suspended call's input has already round-tripped
// through the frame stream once and could be empty or unexpected, and this
// dialog is on the one path a bad payload must never crash: the user still
// needs to be able to deny it.
func TestRender_NeverPanicsOnEmptyOrMalformedInput(t *testing.T) {
	req := session.ApprovalRequest{ToolName: "run_shell", Risk: "exec"}
	for _, input := range [][]byte{nil, {}, []byte("not json"), []byte(`{"unterminated`)} {
		for _, width := range []int{0, 1, 5, 80} {
			_ = Render(width, req, input)
		}
	}
}

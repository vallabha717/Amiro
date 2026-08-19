package toolcard_test

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"amiro/backend/internal/agent/workspace"
	"amiro/backend/internal/ai/tools"
	"amiro/backend/internal/tui/component/toolcard"
	"amiro/backend/internal/tui/session"
)

// This file runs the real internal/ai/tools implementations against a real
// temp workspace and feeds their real output into toolcard.Render.
//
// Every other test in this package hand-writes its JSON fixtures, which
// only proves toolcard's mirrored structs (readFileOutput, editFileOutput,
// shellOutput, ...) agree with themselves -- not with the real tool code
// they're mirrors of. A field renamed on the Go tool side (its own JSON
// tag, not this package's) would silently degrade to a blank card and
// every hand-written-fixture test would keep passing. This is the same
// call internal/tui/client/http_test.go already made for the transport
// side (a real httptest.Server instead of asserting against a mocked
// response) -- a _test.go file importing internal/ai/tools does not ship
// in cmd/amiro (test files never do), so it doesn't compromise the "TUI
// depends on the protocol, not on backend internals" rule that package's
// own non-test code follows.
const cardWidth = 76

func newTestWorkspace(t *testing.T) *workspace.Workspace {
	t.Helper()
	dir := t.TempDir()
	if err := os.WriteFile(filepath.Join(dir, "main.go"), []byte("package main\n\nfunc main() {\n\tprintln(\"hi\")\n}\n"), 0o644); err != nil {
		t.Fatalf("seed main.go: %v", err)
	}
	if err := os.WriteFile(filepath.Join(dir, "README.md"), []byte("# demo\n"), 0o644); err != nil {
		t.Fatalf("seed README.md: %v", err)
	}
	ws, err := workspace.New(dir)
	if err != nil {
		t.Fatalf("workspace.New: %v", err)
	}
	return ws
}

// execute runs the real tool named name and returns its real output,
// marshaled back to the wire JSON toolcard.Render actually consumes.
func execute(t *testing.T, defs []tools.Definition, name string, input any) (outputJSON json.RawMessage, err error) {
	t.Helper()
	def, ok := tools.FindByName(defs, name)
	if !ok {
		t.Fatalf("no tool registered named %q", name)
	}
	inputJSON, err := json.Marshal(input)
	if err != nil {
		t.Fatalf("marshal input: %v", err)
	}
	out, err := def.Execute(context.Background(), inputJSON)
	if err != nil {
		return nil, err
	}
	outputJSON, err = json.Marshal(out)
	if err != nil {
		t.Fatalf("marshal output: %v", err)
	}
	return outputJSON, nil
}

// TestToolCard_RealReadFile runs the real read_file tool and checks its
// real output renders a card with the real line count in it -- not just
// that toolcard.Render returns non-empty.
func TestToolCard_RealReadFile(t *testing.T) {
	ws := newTestWorkspace(t)
	defs := tools.Defaults(tools.Deps{Workspace: ws})

	input := struct {
		Path string `json:"path"`
	}{Path: "main.go"}
	inputJSON, _ := json.Marshal(input)
	outputJSON, err := execute(t, defs, "read_file", input)
	if err != nil {
		t.Fatalf("read_file: %v", err)
	}

	card := toolcard.Render(cardWidth, session.ToolCall{
		Name: "read_file", Input: inputJSON, Output: outputJSON, Status: session.ToolDone,
	})
	if !strings.Contains(card, "main.go") {
		t.Fatalf("card does not mention the file path:\n%s", card)
	}
	if !strings.Contains(card, "5 lines") {
		t.Fatalf("card does not show the real line count (main.go is 5 lines):\n%s\n\nreal output: %s", card, outputJSON)
	}
}

// TestToolCard_RealEditFile runs the real edit_file tool -- proof that
// diff.go's editResult/editFileOutput mirror (Added/Removed/Hunk, with
// hunk lines already "+"/"-" prefixed) matches internal/ai/tools.edit.go's
// actual wire shape, not just what this package assumed it was.
func TestToolCard_RealEditFile(t *testing.T) {
	ws := newTestWorkspace(t)
	defs := tools.Defaults(tools.Deps{Workspace: ws})

	input := struct {
		Path      string `json:"path"`
		OldString string `json:"old_string"`
		NewString string `json:"new_string"`
	}{Path: "main.go", OldString: `println("hi")`, NewString: `println("hello, world")`}
	inputJSON, _ := json.Marshal(input)
	outputJSON, err := execute(t, defs, "edit_file", input)
	if err != nil {
		t.Fatalf("edit_file: %v", err)
	}

	card := toolcard.Render(cardWidth, session.ToolCall{
		Name: "edit_file", Input: inputJSON, Output: outputJSON, Status: session.ToolDone,
	})
	if !strings.Contains(card, "main.go") {
		t.Fatalf("card does not mention the file path:\n%s", card)
	}
	if !strings.Contains(card, `-println("hi")`) {
		t.Fatalf("card does not show the real removed line:\n%s\n\nreal output: %s", card, outputJSON)
	}
	if !strings.Contains(card, `+println("hello, world")`) {
		t.Fatalf("card does not show the real added line:\n%s\n\nreal output: %s", card, outputJSON)
	}
}

// TestToolCard_RealRunShell runs the real run_shell tool -- proof
// shell.go's shellOutput mirror matches terminalOutput's actual wire tags
// (exit_code, output, timed_out), including a genuinely non-zero exit.
func TestToolCard_RealRunShell(t *testing.T) {
	ws := newTestWorkspace(t)
	defs := tools.Defaults(tools.Deps{Workspace: ws})

	input := struct {
		Command string `json:"command"`
	}{Command: "echo real-shell-output && exit 3"}
	inputJSON, _ := json.Marshal(input)
	outputJSON, err := execute(t, defs, "run_shell", input)
	if err != nil {
		t.Fatalf("run_shell: %v", err)
	}

	card := toolcard.Render(cardWidth, session.ToolCall{
		Name: "run_shell", Input: inputJSON, Output: outputJSON, Status: session.ToolDone,
	})
	if !strings.Contains(card, "real-shell-output") {
		t.Fatalf("card does not show the command's real stdout:\n%s\n\nreal output: %s", card, outputJSON)
	}
	if !strings.Contains(card, "exit 3") {
		t.Fatalf("card does not show the real exit code:\n%s\n\nreal output: %s", card, outputJSON)
	}
}

// TestToolCard_RealListDir runs the real list_dir tool -- proof
// files.go's listDirOutput mirror matches the real dir_count/file_count
// tags, over a directory this test actually seeded.
func TestToolCard_RealListDir(t *testing.T) {
	ws := newTestWorkspace(t)
	defs := tools.Defaults(tools.Deps{Workspace: ws})

	input := struct {
		Path string `json:"path"`
	}{Path: "."}
	inputJSON, _ := json.Marshal(input)
	outputJSON, err := execute(t, defs, "list_dir", input)
	if err != nil {
		t.Fatalf("list_dir: %v", err)
	}

	card := toolcard.Render(cardWidth, session.ToolCall{
		Name: "list_dir", Input: inputJSON, Output: outputJSON, Status: session.ToolDone,
	})
	if !strings.Contains(card, "2 files") {
		t.Fatalf("card does not show the real file count (main.go, README.md):\n%s\n\nreal output: %s", card, outputJSON)
	}
}

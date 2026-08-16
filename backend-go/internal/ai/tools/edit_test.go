package tools

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func readBack(t *testing.T, root, rel string) string {
	t.Helper()
	b, err := os.ReadFile(filepath.Join(root, filepath.FromSlash(rel)))
	if err != nil {
		t.Fatal(err)
	}
	return string(b)
}

func TestEditFile_AppliesUniqueAnchorAndReportsDiffCounts(t *testing.T) {
	ws, root := testWorkspace(t)
	defs := Defaults(Deps{Workspace: ws})

	out := mustRun(t, defs, NameEditFile,
		`{"path":"src/app.ts","old_string":"export const a = 1;","new_string":"export const a = 42;\nexport const c = 3;"}`,
	).(EditFileOutput)

	if got := readBack(t, root, "src/app.ts"); !strings.Contains(got, "a = 42") || !strings.Contains(got, "const c = 3") {
		t.Fatalf("file after edit = %q", got)
	}
	if out.Removed != 1 || out.Added != 2 {
		t.Fatalf("counts = +%d -%d, want +2 -1 -- the presenter's diff strip reads these", out.Added, out.Removed)
	}
	if out.Edits[0].AtLine != 1 {
		t.Fatalf("AtLine = %d, want 1", out.Edits[0].AtLine)
	}
	if !strings.Contains(out.Diff, "-export const a = 1;") {
		t.Fatalf("Diff = %q, want a -/+ preview", out.Diff)
	}
}

// The failure that silently corrupts work: an anchor matching more than
// once. Replacing the first occurrence would look like success.
func TestEditFile_RefusesAmbiguousAnchorAndSaysHowManyMatched(t *testing.T) {
	ws, root := testWorkspace(t)
	defs := Defaults(Deps{Workspace: ws})
	mustWrite(t, root, "dup.txt", "target\nmiddle\ntarget\n")
	before := readBack(t, root, "dup.txt")

	_, err := run(t, defs, NameEditFile, `{"path":"dup.txt","old_string":"target","new_string":"changed"}`)
	if err == nil {
		t.Fatal("an anchor matching twice must be refused, not applied to the first hit")
	}
	if !strings.Contains(err.Error(), "appears 2 times") {
		t.Fatalf("error = %v, want the match count so the model knows to widen its anchor", err)
	}
	if readBack(t, root, "dup.txt") != before {
		t.Fatal("a refused edit must leave the file untouched")
	}
}

func TestEditFile_MissingAnchorExplainsWhy(t *testing.T) {
	ws, root := testWorkspace(t)
	defs := Defaults(Deps{Workspace: ws})

	// Whitespace-only mismatch is the most common near miss.
	_, err := run(t, defs, NameEditFile, `{"path":"src/app.ts","old_string":"   export const a = 1;   ","new_string":"x"}`)
	if err == nil {
		t.Fatal("expected a no-match error")
	}
	if !strings.Contains(err.Error(), "different surrounding whitespace") {
		t.Fatalf("error = %v, want the whitespace hint -- a bare 'not found' invites the model to retry the same string", err)
	}

	// Multi-line block whose first line matches but body does not.
	_, err = run(t, defs, NameEditFile, `{"path":"main.go","old_string":"func main() {\n\twrong()\n}","new_string":"x"}`)
	if err == nil || !strings.Contains(err.Error(), "first line matches") {
		t.Fatalf("error = %v, want the partial-match hint", err)
	}
	if readBack(t, root, "main.go") == "" {
		t.Fatal("file should be unchanged and non-empty")
	}
}

// SWE-agent's highest-leverage trick: refuse the edit rather than write a
// file that no longer parses.
func TestEditFile_RejectsEditThatBreaksSyntax(t *testing.T) {
	ws, root := testWorkspace(t)
	defs := Defaults(Deps{Workspace: ws})
	before := readBack(t, root, "main.go")

	_, err := run(t, defs, NameEditFile, `{"path":"main.go","old_string":"func main() {","new_string":"func main( {"}`)
	if err == nil {
		t.Fatal("an edit producing unparseable Go must be rejected")
	}
	if !strings.Contains(err.Error(), "syntactically invalid") {
		t.Fatalf("error = %v, want it to name the syntax failure", err)
	}
	if !strings.Contains(err.Error(), "file is unchanged") {
		t.Fatalf("error = %v, want it to say the file was left alone", err)
	}
	if readBack(t, root, "main.go") != before {
		t.Fatal("a syntax-rejected edit must not be written")
	}
}

func TestEditFile_RejectsInvalidJSONResult(t *testing.T) {
	ws, root := testWorkspace(t)
	defs := Defaults(Deps{Workspace: ws})
	mustWrite(t, root, "cfg.json", "{\n  \"a\": 1\n}\n")

	if _, err := run(t, defs, NameEditFile, `{"path":"cfg.json","old_string":"\"a\": 1","new_string":"\"a\": "}`); err == nil {
		t.Fatal("an edit producing invalid JSON must be rejected")
	}
}

// A language with no cheap parser must not be blocked -- a false rejection
// is worse than a missed catch, since the model cannot argue with a tool
// that refuses to write.
func TestEditFile_AllowsUncheckedLanguagesThrough(t *testing.T) {
	ws, root := testWorkspace(t)
	defs := Defaults(Deps{Workspace: ws})

	if _, err := run(t, defs, NameEditFile, `{"path":"src/app.ts","old_string":"export const b = 2;","new_string":"export const b = ("}`); err != nil {
		t.Fatalf("TypeScript has no syntax gate here, so this must apply: %v", err)
	}
	if !strings.Contains(readBack(t, root, "src/app.ts"), "const b = (") {
		t.Fatal("edit was not written")
	}
}

func TestMultiEdit_IsAtomicAcrossAllEdits(t *testing.T) {
	ws, root := testWorkspace(t)
	defs := Defaults(Deps{Workspace: ws})
	before := readBack(t, root, "src/app.ts")

	// First edit is valid, second cannot match. Nothing must be written.
	_, err := run(t, defs, NameMultiEdit,
		`{"path":"src/app.ts","edits":[
			{"old_string":"export const a = 1;","new_string":"export const a = 9;"},
			{"old_string":"NOT PRESENT ANYWHERE","new_string":"x"}
		]}`)
	if err == nil {
		t.Fatal("expected the failing second edit to abort the batch")
	}
	if !strings.Contains(err.Error(), "edit 2") {
		t.Fatalf("error = %v, want it to identify which edit failed", err)
	}
	if got := readBack(t, root, "src/app.ts"); got != before {
		t.Fatalf("multi_edit is not atomic -- file changed to %q despite a failed edit", got)
	}
}

func TestMultiEdit_AppliesEveryEditInOrder(t *testing.T) {
	ws, root := testWorkspace(t)
	defs := Defaults(Deps{Workspace: ws})

	out := mustRun(t, defs, NameMultiEdit,
		`{"path":"src/app.ts","edits":[
			{"old_string":"export const a = 1;","new_string":"export const a = 9;"},
			{"old_string":"export const b = 2;","new_string":"export const b = 8;"}
		]}`).(EditFileOutput)

	got := readBack(t, root, "src/app.ts")
	if !strings.Contains(got, "a = 9") || !strings.Contains(got, "b = 8") {
		t.Fatalf("file = %q, want both edits applied", got)
	}
	if len(out.Edits) != 2 || out.Added != 2 || out.Removed != 2 {
		t.Fatalf("out = %+v, want 2 edits totalling +2 -2", out)
	}
}

func TestEdit_RejectsNoOpAndEmptyAnchor(t *testing.T) {
	ws, _ := testWorkspace(t)
	defs := Defaults(Deps{Workspace: ws})

	if _, err := run(t, defs, NameEditFile, `{"path":"src/app.ts","old_string":"same","new_string":"same"}`); err == nil {
		t.Fatal("an edit that changes nothing must be an error, not a silent success")
	}
	if _, err := run(t, defs, NameEditFile, `{"path":"src/app.ts","old_string":"","new_string":"x"}`); err == nil {
		t.Fatal("an empty anchor must be refused -- it would match everywhere")
	}
}

func TestEdit_RefusesToLeaveTheWorkspace(t *testing.T) {
	ws, _ := testWorkspace(t)
	defs := Defaults(Deps{Workspace: ws})

	if _, err := run(t, defs, NameEditFile, `{"path":"../outside.txt","old_string":"a","new_string":"b"}`); err == nil {
		t.Fatal("edit outside the workspace must be refused")
	}
}

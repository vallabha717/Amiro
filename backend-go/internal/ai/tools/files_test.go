package tools

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"amiro/backend/internal/agent/workspace"
)

func testWorkspace(t *testing.T) (*workspace.Workspace, string) {
	t.Helper()
	root := t.TempDir()
	mustWrite(t, root, "main.go", "package main\n\nfunc main() {\n\tprintln(\"hi\")\n}\n")
	mustWrite(t, root, "src/app.ts", "export const a = 1;\nexport const b = 2;\n")
	mustWrite(t, root, "src/util.ts", "export function noop() {}\n")
	mustWrite(t, root, "docs/readme.md", "# Title\n\nsome text\n")
	mustWrite(t, root, ".gitignore", "secrets.txt\n*.log\nbuildout/\n")
	mustWrite(t, root, "secrets.txt", "TOKEN=abc\n")
	mustWrite(t, root, "debug.log", "noise\n")
	mustWrite(t, root, "buildout/artifact.js", "compiled\n")

	ws, err := workspace.New(root)
	if err != nil {
		t.Fatal(err)
	}
	return ws, ws.Root()
}

func mustWrite(t *testing.T, root, rel, content string) {
	t.Helper()
	p := filepath.Join(root, filepath.FromSlash(rel))
	if err := os.MkdirAll(filepath.Dir(p), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(p, []byte(content), 0o644); err != nil {
		t.Fatal(err)
	}
}

func run(t *testing.T, defs []Definition, name string, args string) (any, error) {
	t.Helper()
	d, ok := FindByName(defs, name)
	if !ok {
		t.Fatalf("tool %q not registered", name)
	}
	return d.Execute(context.Background(), json.RawMessage(args))
}

func mustRun(t *testing.T, defs []Definition, name, args string) any {
	t.Helper()
	out, err := run(t, defs, name, args)
	if err != nil {
		t.Fatalf("%s(%s): %v", name, args, err)
	}
	return out
}

// A nil workspace must not merely block file access -- the tools must not
// be advertised at all, or the model wastes turns calling something that
// can only ever fail.
func TestDefaults_OmitsFileToolsWithoutAWorkspace(t *testing.T) {
	defs := Defaults(Deps{})
	for _, name := range []string{NameReadFile, NameListDir, NameWriteFile, NameGlob, NameGrep, NameEditFile, NameMultiEdit} {
		if _, ok := FindByName(defs, name); ok {
			t.Fatalf("%s was offered with no workspace configured", name)
		}
	}
	if _, ok := FindByName(defs, NameCreatePieChart); !ok {
		t.Fatal("non-file tools must still be offered without a workspace")
	}
}

func TestDefaults_FileToolsDeclareCorrectConcurrency(t *testing.T) {
	ws, _ := testWorkspace(t)
	defs := Defaults(Deps{Workspace: ws})

	parallel := []string{NameReadFile, NameListDir, NameGlob, NameGrep}
	sequential := []string{NameWriteFile, NameEditFile, NameMultiEdit, NameGit}

	for _, n := range parallel {
		d, _ := FindByName(defs, n)
		if d.Concurrency() != Parallel {
			t.Fatalf("%s must be Parallel -- reads are the whole point of the scheduler", n)
		}
	}
	for _, n := range sequential {
		d, _ := FindByName(defs, n)
		if d.Concurrency() != Sequential {
			t.Fatalf("%s must be Sequential -- overlapping writes is a correctness bug", n)
		}
	}
}

func TestReadFile_NumbersLinesAndReportsTotals(t *testing.T) {
	ws, _ := testWorkspace(t)
	defs := Defaults(Deps{Workspace: ws})

	out := mustRun(t, defs, NameReadFile, `{"path":"src/app.ts"}`).(ReadFileOutput)
	if out.TotalLine != 2 {
		t.Fatalf("TotalLine = %d, want 2", out.TotalLine)
	}
	if !strings.Contains(out.Content, "1\texport const a = 1;") {
		t.Fatalf("Content = %q, want line-numbered output", out.Content)
	}
	if out.Truncated {
		t.Fatal("a 2-line file must not report truncation")
	}
}

func TestReadFile_WindowsLargeFilesAndSaysSo(t *testing.T) {
	ws, root := testWorkspace(t)
	defs := Defaults(Deps{Workspace: ws})

	var b strings.Builder
	for i := 1; i <= 50; i++ {
		b.WriteString("line\n")
	}
	mustWrite(t, root, "big.txt", b.String())

	out := mustRun(t, defs, NameReadFile, `{"path":"big.txt","offset":10,"limit":5}`).(ReadFileOutput)
	if out.StartLine != 10 || out.EndLine != 14 {
		t.Fatalf("window = %d-%d, want 10-14", out.StartLine, out.EndLine)
	}
	if !out.Truncated {
		t.Fatal("a windowed read must set Truncated -- a model that thinks it saw the whole file edits against content that isn't there")
	}
	if !strings.Contains(out.Notice, "offset=15") {
		t.Fatalf("Notice = %q, want it to say how to get the next page", out.Notice)
	}
}

func TestReadFile_RejectsBinaryDirectoriesAndEscapes(t *testing.T) {
	ws, root := testWorkspace(t)
	defs := Defaults(Deps{Workspace: ws})

	if err := os.WriteFile(filepath.Join(root, "blob.bin"), []byte{0x00, 0x01, 0x02}, 0o644); err != nil {
		t.Fatal(err)
	}

	for _, tc := range []struct{ name, args, want string }{
		{"binary", `{"path":"blob.bin"}`, "binary"},
		{"directory", `{"path":"src"}`, "directory"},
		{"escape", `{"path":"../../etc/passwd"}`, "outside the workspace root"},
	} {
		_, err := run(t, defs, NameReadFile, tc.args)
		if err == nil {
			t.Fatalf("%s: expected an error", tc.name)
		}
		if !strings.Contains(err.Error(), tc.want) {
			t.Fatalf("%s: error = %v, want it to mention %q", tc.name, err, tc.want)
		}
	}
}

func TestListDir_SkipsGitignoredAndAlwaysIgnoredPaths(t *testing.T) {
	ws, root := testWorkspace(t)
	defs := Defaults(Deps{Workspace: ws})
	mustWrite(t, root, "node_modules/pkg/index.js", "x\n")

	out := mustRun(t, defs, NameListDir, `{"path":".","depth":3}`).(ListDirOutput)
	joined := ""
	for _, e := range out.Entries {
		joined += e.Path + "\n"
	}
	for _, unwanted := range []string{"secrets.txt", "debug.log", "buildout", "node_modules"} {
		if strings.Contains(joined, unwanted) {
			t.Fatalf("listing included %q, which .gitignore or alwaysIgnored should have hidden:\n%s", unwanted, joined)
		}
	}
	if !strings.Contains(joined, "main.go") {
		t.Fatalf("listing missed main.go:\n%s", joined)
	}
	if out.FileCount == 0 || out.DirCount == 0 {
		t.Fatalf("counts = %d files / %d dirs, want both non-zero (the presenter's glance line needs them)", out.FileCount, out.DirCount)
	}
}

func TestGlob_MatchesAcrossSegmentsAndSortsNewestFirst(t *testing.T) {
	ws, _ := testWorkspace(t)
	defs := Defaults(Deps{Workspace: ws})

	out := mustRun(t, defs, NameGlob, `{"pattern":"**/*.ts"}`).(GlobOutput)
	if out.Count != 2 {
		t.Fatalf("Count = %d, want 2 (.ts files under src/); matches=%+v", out.Count, out.Matches)
	}
	for i := 1; i < len(out.Matches); i++ {
		if out.Matches[i-1].ModTime < out.Matches[i].ModTime {
			t.Fatal("matches must be newest-first")
		}
	}

	// **/ must also match zero directories.
	if got := mustRun(t, defs, NameGlob, `{"pattern":"**/main.go"}`).(GlobOutput); got.Count != 1 {
		t.Fatalf("**/main.go matched %d, want 1 -- '**/' has to match zero directories too", got.Count)
	}
	// A single * must not cross a separator.
	if got := mustRun(t, defs, NameGlob, `{"pattern":"*.ts"}`).(GlobOutput); got.Count != 0 {
		t.Fatalf("*.ts matched %d at the root, want 0 -- a single star must not cross directories", got.Count)
	}
}

func TestGrep_ReportsHitsWithFileCountAndRespectsInclude(t *testing.T) {
	ws, _ := testWorkspace(t)
	defs := Defaults(Deps{Workspace: ws})

	out := mustRun(t, defs, NameGrep, `{"pattern":"export const"}`).(GrepOutput)
	if out.Count != 2 || out.FileCount != 1 {
		t.Fatalf("got %d hits in %d files, want 2 in 1", out.Count, out.FileCount)
	}
	if out.Hits[0].Line != 1 {
		t.Fatalf("first hit line = %d, want 1", out.Hits[0].Line)
	}

	scoped := mustRun(t, defs, NameGrep, `{"pattern":"export","include":"**/util.ts"}`).(GrepOutput)
	if scoped.FileCount != 1 || !strings.HasSuffix(scoped.Hits[0].Path, "util.ts") {
		t.Fatalf("include filter did not scope the search: %+v", scoped.Hits)
	}

	none := mustRun(t, defs, NameGrep, `{"pattern":"zzz-not-present"}`).(GrepOutput)
	if none.Count != 0 || none.Notice != "no matches" {
		t.Fatalf("empty result = %+v, want a clear 'no matches' notice rather than silence", none)
	}
}

func TestGrep_IsCaseInsensitiveByDefault(t *testing.T) {
	ws, _ := testWorkspace(t)
	defs := Defaults(Deps{Workspace: ws})

	if out := mustRun(t, defs, NameGrep, `{"pattern":"EXPORT CONST"}`).(GrepOutput); out.Count != 2 {
		t.Fatalf("case-insensitive default matched %d, want 2", out.Count)
	}
	if out := mustRun(t, defs, NameGrep, `{"pattern":"EXPORT CONST","case_sensitive":true}`).(GrepOutput); out.Count != 0 {
		t.Fatalf("case_sensitive=true matched %d, want 0", out.Count)
	}
}

func TestWriteFile_CreatesAndReportsWhetherItOverwrote(t *testing.T) {
	ws, _ := testWorkspace(t)
	defs := Defaults(Deps{Workspace: ws})

	out := mustRun(t, defs, NameWriteFile, `{"path":"new/nested/file.txt","content":"a\nb\n"}`).(WriteFileOutput)
	if !out.Created || out.Overwrote {
		t.Fatalf("first write = %+v, want Created", out)
	}
	if out.Lines != 2 {
		t.Fatalf("Lines = %d, want 2", out.Lines)
	}

	again := mustRun(t, defs, NameWriteFile, `{"path":"new/nested/file.txt","content":"c\n"}`).(WriteFileOutput)
	if again.Created || !again.Overwrote {
		t.Fatalf("second write = %+v, want Overwrote -- the presenter distinguishes them", again)
	}

	if _, err := run(t, defs, NameWriteFile, `{"path":"../escape.txt","content":"x"}`); err == nil {
		t.Fatal("write outside the workspace must be refused")
	}
}

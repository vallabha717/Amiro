package workspace

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func newTestWorkspace(t *testing.T) (*Workspace, string) {
	t.Helper()
	root := t.TempDir()
	if err := os.MkdirAll(filepath.Join(root, "src", "lib"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(root, "src", "lib", "utils.go"), []byte("package lib\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	w, err := New(root)
	if err != nil {
		t.Fatalf("New: %v", err)
	}
	return w, w.Root()
}

func TestResolve_AllowsPathsInsideTheRoot(t *testing.T) {
	w, root := newTestWorkspace(t)

	for _, in := range []string{
		"src/lib/utils.go",
		"./src/lib/utils.go",
		"src/../src/lib/utils.go", // traversal that lands back inside is fine
		filepath.Join(root, "src", "lib", "utils.go"),
	} {
		got, err := w.Resolve(in)
		if err != nil {
			t.Fatalf("Resolve(%q): unexpected error %v", in, err)
		}
		want := filepath.Join(root, "src", "lib", "utils.go")
		if got != want {
			t.Fatalf("Resolve(%q) = %q, want %q", in, got, want)
		}
	}
}

// A path that does not exist yet must resolve: write_file has to be able to
// create one. This is the case that rules out "just EvalSymlinks it".
func TestResolve_AllowsNonexistentPathForCreation(t *testing.T) {
	w, root := newTestWorkspace(t)

	got, err := w.Resolve("src/lib/brand_new.go")
	if err != nil {
		t.Fatalf("Resolve of a not-yet-created file: %v", err)
	}
	if want := filepath.Join(root, "src", "lib", "brand_new.go"); got != want {
		t.Fatalf("Resolve = %q, want %q", got, want)
	}

	// Several levels of not-yet-existing directories too.
	if _, err := w.Resolve("a/b/c/d.txt"); err != nil {
		t.Fatalf("Resolve of a deep uncreated path: %v", err)
	}
}

func TestResolve_RejectsTraversalOutOfTheRoot(t *testing.T) {
	w, _ := newTestWorkspace(t)

	for _, in := range []string{
		"../outside.txt",
		"src/../../outside.txt",
		"../../../../etc/passwd",
		"/etc/passwd",
	} {
		got, err := w.Resolve(in)
		if err == nil {
			t.Fatalf("Resolve(%q) = %q, want an escape error -- the model must not reach outside the workspace", in, got)
		}
		var esc *EscapeError
		if !asEscape(err, &esc) {
			t.Fatalf("Resolve(%q) error = %T (%v), want *EscapeError", in, err, err)
		}
	}
}

// The subtle one: the leaf does not exist, but its parent is a symlink
// pointing outside the workspace. Resolving only the parts that exist is
// what catches this; an implementation that shrugs at ErrNotExist and
// returns the cleaned path lets the write through.
func TestResolve_RejectsWriteThroughSymlinkedParent(t *testing.T) {
	w, root := newTestWorkspace(t)
	outside := t.TempDir()

	link := filepath.Join(root, "escape")
	if err := os.Symlink(outside, link); err != nil {
		t.Skipf("symlinks unavailable: %v", err)
	}

	got, err := w.Resolve("escape/pwned.txt")
	if err == nil {
		t.Fatalf("Resolve through a symlinked-out parent = %q, want an escape error", got)
	}
	if !strings.Contains(err.Error(), "outside the workspace root") {
		t.Fatalf("error = %v, want it to name the containment failure", err)
	}
}

// Same idea, but the symlink itself is the leaf and it already exists.
func TestResolve_RejectsSymlinkPointingOutOfTheRoot(t *testing.T) {
	w, root := newTestWorkspace(t)
	outside := t.TempDir()
	target := filepath.Join(outside, "secret.txt")
	if err := os.WriteFile(target, []byte("secret"), 0o644); err != nil {
		t.Fatal(err)
	}

	link := filepath.Join(root, "secret-link")
	if err := os.Symlink(target, link); err != nil {
		t.Skipf("symlinks unavailable: %v", err)
	}

	if got, err := w.Resolve("secret-link"); err == nil {
		t.Fatalf("Resolve of a symlink to outside = %q, want an escape error", got)
	}
}

// A symlink that stays inside the workspace is legitimate and must work --
// otherwise containment breaks ordinary repos (vendored dirs, monorepo
// package links).
func TestResolve_AllowsSymlinkStayingInsideTheRoot(t *testing.T) {
	w, root := newTestWorkspace(t)

	link := filepath.Join(root, "lib-link")
	if err := os.Symlink(filepath.Join(root, "src", "lib"), link); err != nil {
		t.Skipf("symlinks unavailable: %v", err)
	}

	got, err := w.Resolve("lib-link/utils.go")
	if err != nil {
		t.Fatalf("Resolve through an internal symlink: %v", err)
	}
	if want := filepath.Join(root, "src", "lib", "utils.go"); got != want {
		t.Fatalf("Resolve = %q, want %q", got, want)
	}
}

func TestResolve_RejectsEmptyPath(t *testing.T) {
	w, _ := newTestWorkspace(t)
	for _, in := range []string{"", "   "} {
		if _, err := w.Resolve(in); err != ErrEmptyPath {
			t.Fatalf("Resolve(%q) error = %v, want ErrEmptyPath", in, err)
		}
	}
}

func TestRel_ReturnsWorkspaceRelativePathsForDisplay(t *testing.T) {
	w, root := newTestWorkspace(t)

	rel, err := w.Rel(filepath.Join(root, "src", "lib", "utils.go"))
	if err != nil {
		t.Fatalf("Rel: %v", err)
	}
	if want := filepath.Join("src", "lib", "utils.go"); rel != want {
		t.Fatalf("Rel = %q, want %q -- transcripts must not leak the absolute layout", rel, want)
	}

	if _, err := w.Rel(filepath.Join(filepath.Dir(root), "elsewhere.txt")); err == nil {
		t.Fatal("Rel of an outside path returned no error")
	}
}

func TestNew_RejectsMissingRootAndFiles(t *testing.T) {
	if _, err := New(filepath.Join(t.TempDir(), "nope")); err == nil {
		t.Fatal("New of a missing directory returned no error")
	}

	f := filepath.Join(t.TempDir(), "file.txt")
	if err := os.WriteFile(f, []byte("x"), 0o644); err != nil {
		t.Fatal(err)
	}
	if _, err := New(f); err == nil {
		t.Fatal("New rooted at a file returned no error")
	}
	if _, err := New(""); err != ErrEmptyPath {
		t.Fatalf("New(\"\") error = %v, want ErrEmptyPath", err)
	}
}

func asEscape(err error, target **EscapeError) bool {
	e, ok := err.(*EscapeError)
	if ok {
		*target = e
	}
	return ok
}

func TestResolveReadable_AllowsWorkspaceAndReadOnlyRoots(t *testing.T) {
	w, root := newTestWorkspace(t)

	// Create an external read-only skill directory
	skillDir := t.TempDir()
	refFile := filepath.Join(skillDir, "references", "guide.md")
	if err := os.MkdirAll(filepath.Dir(refFile), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(refFile, []byte("# Guide"), 0o644); err != nil {
		t.Fatal(err)
	}

	wWithRoots := w.WithReadOnlyRoots([]string{skillDir})

	// Inside workspace: works with both Resolve and ResolveReadable
	wsFile := filepath.Join(root, "src", "lib", "utils.go")
	if got, err := wWithRoots.Resolve(wsFile); err != nil || got != wsFile {
		t.Fatalf("Resolve(%q) = %q, %v", wsFile, got, err)
	}
	if got, err := wWithRoots.ResolveReadable(wsFile); err != nil || got != wsFile {
		t.Fatalf("ResolveReadable(%q) = %q, %v", wsFile, got, err)
	}

	// Inside read-only root: ResolveReadable succeeds, Resolve fails!
	if got, err := wWithRoots.ResolveReadable(refFile); err != nil || got != refFile {
		t.Fatalf("ResolveReadable(%q) = %q, %v", refFile, got, err)
	}
	if _, err := wWithRoots.Resolve(refFile); err == nil {
		t.Fatalf("Resolve(%q) must refuse a path outside the workspace root even if in ReadOnlyRoots", refFile)
	}

	// Outside both: both fail
	outside := filepath.Join(t.TempDir(), "other.txt")
	if _, err := wWithRoots.Resolve(outside); err == nil {
		t.Fatalf("Resolve(%q) must fail", outside)
	}
	if _, err := wWithRoots.ResolveReadable(outside); err == nil {
		t.Fatalf("ResolveReadable(%q) must fail", outside)
	}

	// RelReadable returns relative path
	rel, err := wWithRoots.RelReadable(refFile)
	if err != nil {
		t.Fatalf("RelReadable(%q): %v", refFile, err)
	}
	if rel != filepath.Join("references", "guide.md") {
		t.Errorf("RelReadable(%q) = %q, want references/guide.md", refFile, rel)
	}
}

func TestWorkspace_ConcurrentAddAndResolve_Race(t *testing.T) {
	w, _ := newTestWorkspace(t)

	// Outside root path so ResolveReadable traverses readOnlyRoots under lock
	outsideDir := t.TempDir()
	outsideFile := filepath.Join(outsideDir, "doc.txt")
	if err := os.WriteFile(outsideFile, []byte("content"), 0o644); err != nil {
		t.Fatal(err)
	}

	done := make(chan struct{})
	go func() {
		for i := 0; i < 200; i++ {
			select {
			case <-done:
				return
			default:
				w.AddReadOnlyRoots(t.TempDir(), outsideDir)
			}
		}
	}()

	for i := 0; i < 200; i++ {
		_, _ = w.ResolveReadable(outsideFile)
		_ = w.ReadOnlyRoots()
		_, _ = w.RelReadable(outsideFile)
	}
	close(done)
}

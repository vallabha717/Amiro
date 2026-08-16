package memory

import (
	"os"
	"strings"
	"testing"
	"time"
)

func open(t *testing.T) *Store {
	t.Helper()
	s, err := Open(t.TempDir(), "/some/workspace")
	if err != nil {
		t.Fatalf("Open: %v", err)
	}
	return s
}

func TestRemember_RoundTripsThroughDisk(t *testing.T) {
	dir := t.TempDir()
	s, _ := Open(dir, "/w")
	if _, err := s.Remember("the tests are run with pnpm test", []string{"testing"}, "thread-1"); err != nil {
		t.Fatalf("Remember: %v", err)
	}

	// A second store over the same directory: the point of the feature is
	// surviving a process, not a variable.
	again, _ := Open(dir, "/w")
	all := again.All()
	if len(all) != 1 || !strings.Contains(all[0].Text, "pnpm test") {
		t.Fatalf("All() = %+v after reopening", all)
	}
	if all[0].Source != "thread-1" {
		t.Fatalf("Source = %q, want the writing thread's id", all[0].Source)
	}
}

// Repeating a fact is the signal it is still true, so it bumps the entry
// rather than creating a second one.
func TestRemember_RepeatingAFactUpdatesItInsteadOfDuplicating(t *testing.T) {
	s := open(t)
	first, _ := s.Remember("the Go code lives under backend-go", nil, "t1")
	time.Sleep(2 * time.Millisecond)
	second, _ := s.Remember("The Go code lives   under backend-go  ", []string{"layout"}, "t2")

	if got := s.All(); len(got) != 1 {
		t.Fatalf("%d entries, want 1 -- normalized-identical text must dedupe", len(got))
	}
	if second.ID != first.ID {
		t.Fatalf("id changed on repeat: %q -> %q", first.ID, second.ID)
	}
	if !second.UpdatedAt.After(first.UpdatedAt) {
		t.Fatal("UpdatedAt did not advance; reinforcement is what keeps a memory alive through eviction")
	}
	if len(second.Tags) != 1 || second.Tags[0] != "layout" {
		t.Fatalf("Tags = %v, want the repeat's tags merged in", second.Tags)
	}
}

// Fuzzy dedup would merge two facts that differ in the one word that
// matters. Distinct text stays distinct.
func TestRemember_KeepsSimilarButDifferentFactsApart(t *testing.T) {
	s := open(t)
	_, _ = s.Remember("the tests are run with pnpm test", nil, "t")
	_, _ = s.Remember("the e2e tests are run with pnpm test:e2e", nil, "t")
	if got := s.All(); len(got) != 2 {
		t.Fatalf("%d entries, want 2 -- these are different facts", len(got))
	}
}

func TestRemember_RejectsAnEssayInsteadOfAFact(t *testing.T) {
	s := open(t)
	if _, err := s.Remember(strings.Repeat("x", maxEntryChars+1), nil, "t"); err == nil {
		t.Fatal("accepted an over-long memory")
	}
	if _, err := s.Remember("   ", nil, "t"); err == nil {
		t.Fatal("accepted an empty memory")
	}
}

func TestForget_RemovesByIDAndReportsWhetherItExisted(t *testing.T) {
	s := open(t)
	e, _ := s.Remember("something wrong", nil, "t")

	removed, err := s.Forget(e.ID)
	if err != nil || !removed {
		t.Fatalf("Forget(%q) = %v, %v", e.ID, removed, err)
	}
	if len(s.All()) != 0 {
		t.Fatal("entry survived Forget")
	}
	if removed, _ := s.Forget("nope"); removed {
		t.Fatal("Forget reported removing an id that was never there")
	}
}

func TestSearch_RequiresEveryTerm(t *testing.T) {
	s := open(t)
	_, _ = s.Remember("the build command is make release", []string{"build"}, "t")
	_, _ = s.Remember("the linter is golangci-lint", []string{"lint"}, "t")

	if hits := s.Search("build command", 0); len(hits) != 1 {
		t.Fatalf("Search(\"build command\") = %d hits, want 1", len(hits))
	}
	if hits := s.Search("build linter", 0); len(hits) != 0 {
		t.Fatalf("Search with terms from two different notes matched %d; every term must appear", len(hits))
	}
	if hits := s.Search("lint", 0); len(hits) != 1 {
		t.Fatalf("tag search returned %d hits, want 1", len(hits))
	}
}

// A store that only grows becomes a second context window nobody compacts.
func TestRemember_EvictsTheLeastRecentlyReinforcedOverTheCap(t *testing.T) {
	s := open(t)
	for i := 0; i < maxEntries+10; i++ {
		if _, err := s.Remember("fact number "+string(rune('a'+i%26))+string(rune('a'+i/26)), nil, "t"); err != nil {
			t.Fatal(err)
		}
	}
	if got := len(s.All()); got > maxEntries {
		t.Fatalf("%d entries, over the %d cap", got, maxEntries)
	}
}

// Injection is the primary path, so the prompt has to exist, name the
// tools, and be honest about what these are.
func TestPrompt_FramesNotesAsFallibleRatherThanAsFact(t *testing.T) {
	s := open(t)
	if s.Prompt() != "" {
		t.Fatal("an empty store produced a prompt section")
	}
	_, _ = s.Remember("the API base path is /api/v2", nil, "t")

	p := s.Prompt()
	if !strings.Contains(p, "/api/v2") {
		t.Fatalf("prompt does not contain the note:\n%s", p)
	}
	if !strings.Contains(p, "not ground truth") {
		t.Fatalf("prompt states notes as fact; a stale note stated as truth is how an agent insists a deleted file exists:\n%s", p)
	}
	if !strings.Contains(p, "memory_write") {
		t.Fatalf("prompt does not tell the model how to correct a wrong note:\n%s", p)
	}
}

// Every conversation in the workspace pays the injection on every turn.
func TestPrompt_StaysWithinItsBudget(t *testing.T) {
	s := open(t)
	for i := 0; i < 150; i++ {
		_, _ = s.Remember(strings.Repeat("z", 100)+string(rune('a'+i%26))+string(rune('a'+i/26)), nil, "t")
	}
	if got := len(s.Prompt()); got > promptBudgetChars+400 {
		t.Fatalf("prompt is %d chars against a %d budget", got, promptBudgetChars)
	}
	if !strings.Contains(s.Prompt(), "memory_read") {
		t.Fatal("truncated the notes without telling the model the rest is searchable")
	}
}

// The whole point of scoping: a fact about one repo must not follow the
// agent into another.
func TestOpen_ScopesMemoriesToTheWorkspace(t *testing.T) {
	dir := t.TempDir()
	a, _ := Open(dir, "/projects/alpha")
	b, _ := Open(dir, "/projects/beta")

	_, _ = a.Remember("alpha uses bazel", nil, "t")
	if len(b.All()) != 0 {
		t.Fatalf("beta sees alpha's memories: %+v", b.All())
	}
	if a.Path() == b.Path() {
		t.Fatal("two workspaces share one file")
	}
}

// A corrupt file must not wedge every request in the workspace.
func TestAll_SurvivesACorruptStoreFile(t *testing.T) {
	dir := t.TempDir()
	s, _ := Open(dir, "/w")
	_, _ = s.Remember("something", nil, "t")
	if err := os.WriteFile(s.Path(), []byte("{not json"), 0o600); err != nil {
		t.Fatal(err)
	}
	if got := s.All(); got != nil && len(got) != 0 {
		t.Fatalf("All() on a corrupt file = %+v, want empty", got)
	}
	if _, err := s.Remember("a fresh start", nil, "t"); err != nil {
		t.Fatalf("could not write after corruption: %v", err)
	}
}

func TestOpen_RefusesWithoutBothADirectoryAndARoot(t *testing.T) {
	if _, err := Open("", "/w"); err == nil {
		t.Fatal("opened with no data directory")
	}
	if _, err := Open(t.TempDir(), ""); err == nil {
		t.Fatal("opened with no workspace root")
	}
}

// A nil store is the "no workspace configured" case and must be inert
// rather than a panic on a path nobody tested.
func TestNilStore_IsInert(t *testing.T) {
	var s *Store
	if got := s.All(); got != nil {
		t.Fatalf("nil.All() = %v", got)
	}
	if got := s.Prompt(); got != "" {
		t.Fatalf("nil.Prompt() = %q", got)
	}
	if got := s.Path(); got != "" {
		t.Fatalf("nil.Path() = %q", got)
	}
	if _, err := s.Remember("x", nil, "t"); err == nil {
		t.Fatal("nil.Remember succeeded")
	}
}

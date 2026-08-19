package selector

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// tree builds a fake tests/ layout so selection can be tested without the
// real suites, which change every phase.
func tree(t *testing.T, files map[string]string) string {
	t.Helper()
	dir := t.TempDir()
	for rel, body := range files {
		full := filepath.Join(dir, filepath.FromSlash(rel))
		if err := os.MkdirAll(filepath.Dir(full), 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(full, []byte(body), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	return dir
}

const goSuite = "package x_test\n\nfunc TestOne(t *testing.T) {}\nfunc TestTwo(t *testing.T) {}\n"
const spec = "test(\"streams tokens into the bubble\", async () => {});\n"

func fullTree(t *testing.T) string {
	return tree(t, map[string]string{
		"suites/backend/chat/stream_test.go": goSuite,
		"suites/backend/auth/login_test.go":  goSuite,
		"suites/tui/chat/render_test.go":     goSuite,
		"suites/meta/guard_test.go":          goSuite,
		"ui/specs/chat/streaming.spec.ts":    spec,
		"ui/specs/auth/signin.spec.ts":       spec,
	})
}

func TestDiscover_DerivesAddressesFromTheFilesystem(t *testing.T) {
	cat, err := Discover(fullTree(t))
	if err != nil {
		t.Fatalf("Discover: %v", err)
	}
	got := map[string]bool{}
	for _, f := range cat.Features {
		got[f.Surface+"/"+f.Name] = true
	}
	for _, want := range []string{"backend/chat", "backend/auth", "tui/chat", "ui/chat", "ui/auth", "meta/meta"} {
		if !got[want] {
			t.Errorf("feature %s was not discovered (found %v)", want, keys(got))
		}
	}
	// A surface directory holding test files directly is its own single
	// feature -- suites/meta is shaped that way -- but a surface whose
	// children hold the tests must NOT also appear as a feature of itself,
	// or every address under it is counted twice.
	if got["backend/backend"] {
		t.Error("suites/backend/ was reported as its own feature; its tests live in its children")
	}
}

func TestDiscover_TreatsAMissingSurfaceAsEmptyRatherThanAnError(t *testing.T) {
	// Phases land one surface at a time. `amirotest list` on a tree with
	// only suites/backend/ should print what is there.
	cat, err := Discover(tree(t, map[string]string{"suites/backend/chat/x_test.go": goSuite}))
	if err != nil {
		t.Fatalf("a tree with only one surface must not error: %v", err)
	}
	if len(cat.Features) != 1 {
		t.Errorf("found %d features, want 1", len(cat.Features))
	}
}

func TestResolve_OneFeatureOfOneSurface(t *testing.T) {
	cat, _ := Discover(fullTree(t))
	inv, _, err := Resolve(Selection{Surfaces: []string{"backend"}, Features: []string{"chat"}}, cat)
	if err != nil {
		t.Fatalf("Resolve: %v", err)
	}
	if len(inv) != 1 {
		t.Fatalf("got %d invocations, want 1: %+v", len(inv), inv)
	}
	if inv[0].Runner != "go" {
		t.Errorf("runner = %q", inv[0].Runner)
	}
	joined := strings.Join(inv[0].Args, " ")
	if !strings.Contains(joined, "./suites/backend/chat/...") {
		t.Errorf("args do not name the package: %s", joined)
	}
	if strings.Contains(joined, "auth") {
		t.Errorf("args include an unselected feature: %s", joined)
	}
}

// TestResolve_FeatureWithNoSurfaceSpansEverySurfaceThatHasIt is the mode the
// plan calls the most useful one: prove one feature end to end everywhere it
// exists, right after changing it.
func TestResolve_FeatureWithNoSurfaceSpansEverySurfaceThatHasIt(t *testing.T) {
	cat, _ := Discover(fullTree(t))
	inv, _, err := Resolve(Selection{Features: []string{"chat"}}, cat)
	if err != nil {
		t.Fatalf("Resolve: %v", err)
	}
	surfaces := map[string]bool{}
	for _, i := range inv {
		surfaces[i.Surface] = true
	}
	for _, want := range []string{"backend", "tui", "ui"} {
		if !surfaces[want] {
			t.Errorf("surface %s has a chat feature but produced no invocation (got %v)", want, keys(surfaces))
		}
	}
	if surfaces["meta"] {
		t.Error("meta has no chat feature but produced an invocation")
	}
}

// TestResolve_UnknownFeatureIsAnErrorListingTheValidOnes -- never a silent
// zero-test pass. "There is no chat suite yet" and "you typed caht" are
// different problems, and only one of them is the user's typo.
func TestResolve_UnknownFeatureIsAnErrorListingTheValidOnes(t *testing.T) {
	cat, _ := Discover(fullTree(t))
	_, _, err := Resolve(Selection{Features: []string{"caht"}}, cat)
	if err == nil {
		t.Fatal("an unknown feature must be an error, not an empty run")
	}
	for _, want := range []string{"caht", "chat", "auth"} {
		if !strings.Contains(err.Error(), want) {
			t.Errorf("the error does not mention %q: %v", want, err)
		}
	}
}

func TestResolve_UnknownSurfaceIsAnError(t *testing.T) {
	cat, _ := Discover(fullTree(t))
	if _, _, err := Resolve(Selection{Surfaces: []string{"frontend"}}, cat); err == nil {
		t.Fatal("expected an error for an unknown surface")
	}
}

func TestResolve_UISurfaceProducesAPlaywrightInvocation(t *testing.T) {
	cat, _ := Discover(fullTree(t))
	inv, _, err := Resolve(Selection{Surfaces: []string{"ui"}, Features: []string{"chat"},
		Grep: "streams", Browsers: []string{"firefox"}}, cat)
	if err != nil {
		t.Fatalf("Resolve: %v", err)
	}
	joined := strings.Join(inv[0].Args, " ")
	for _, want := range []string{"playwright", "test", "ui/specs/chat", "--grep streams", "--project firefox"} {
		if !strings.Contains(joined, want) {
			t.Errorf("args missing %q: %s", want, joined)
		}
	}
}

func TestResolve_DesktopIsMarkedSerial(t *testing.T) {
	cat, _ := Discover(tree(t, map[string]string{"suites/desktop/lifecycle/x_test.go": goSuite}))
	inv, _, err := Resolve(Selection{}, cat)
	if err != nil {
		t.Fatalf("Resolve: %v", err)
	}
	if !inv[0].Serial {
		t.Error("the desktop surface must be serial: it binds a real window, and overlapping instances fight")
	}
}

func TestResolve_OrdersSurfacesSoFailuresAreReadable(t *testing.T) {
	cat, _ := Discover(fullTree(t))
	inv, _, err := Resolve(Selection{}, cat)
	if err != nil {
		t.Fatalf("Resolve: %v", err)
	}
	var order []string
	for _, i := range inv {
		order = append(order, i.Surface)
	}
	// meta first (the guards fail fast and cheaply), cross and desktop last.
	if order[0] != "meta" {
		t.Errorf("surface order is %v; meta should run first", order)
	}
}

func TestDecide_ExcludeBeatsIncludeAndAlwaysGivesAReason(t *testing.T) {
	sel := Selection{TagsExclude: []string{"live", "slow"}}

	if d := Decide(nil, sel); !d.Run {
		t.Error("an untagged test must run")
	}
	d := Decide([]string{"live"}, sel)
	if d.Run {
		t.Error("a live-tagged test must not run when live is excluded")
	}
	if d.Reason == "" {
		t.Error("a skip with no reason is a silent pass")
	}
	if !strings.Contains(d.Reason, "live") {
		t.Errorf("the reason does not name the tag: %q", d.Reason)
	}

	// Include is an OR across the test's tags.
	sel = Selection{TagsInclude: []string{"smoke"}}
	if d := Decide([]string{"smoke", "slow"}, sel); !d.Run {
		t.Error("a test carrying a required tag must run")
	}
	if d := Decide([]string{"slow"}, sel); d.Run {
		t.Error("a test carrying none of the required tags must not run")
	}
}

func keys(m map[string]bool) []string {
	var out []string
	for k := range m {
		out = append(out, k)
	}
	return out
}

// TestResolve_ReportsASelectedSurfaceThatHasNoSuiteYet is the other half of
// the "never a silent zero-test pass" rule.
//
// A surface that was asked for and contributed nothing has to be visible in
// the summary. "ui: 0 tests" reading as green when there is no UI suite at
// all is exactly the failure this package is arranged against.
func TestResolve_ReportsASelectedSurfaceThatHasNoSuiteYet(t *testing.T) {
	cat, _ := Discover(tree(t, map[string]string{"suites/backend/smoke/x_test.go": goSuite}))
	inv, empty, err := Resolve(Selection{Surfaces: []string{"backend", "tui", "ui", "desktop"}}, cat)
	if err != nil {
		t.Fatalf("Resolve: %v", err)
	}
	if len(inv) != 1 {
		t.Errorf("got %d invocations, want 1 (only backend has a suite)", len(inv))
	}
	got := map[string]bool{}
	for _, s := range empty {
		got[s] = true
	}
	for _, want := range []string{"tui", "ui", "desktop"} {
		if !got[want] {
			t.Errorf("surface %s has no suite but was not reported empty (got %v)", want, empty)
		}
	}
	if got["backend"] {
		t.Error("backend has a suite and must not be reported empty")
	}
}

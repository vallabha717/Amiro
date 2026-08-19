// Package selector turns a selection -- surfaces, features, a grep, tags --
// into concrete runner invocations, and answers the same question in the
// other direction for a test that is already running.
//
// The addressing scheme is the filesystem (docs/testing/03-selection.md):
//
//	suites/backend/chat/stream_test.go  ->  backend/chat/TestStream_...
//	ui/specs/chat/streaming.spec.ts     ->  ui/chat/"streams tokens..."
//
// There is no registry file. Adding a feature means creating a directory,
// and nothing can fall out of sync with something that is derived.
package selector

import (
	"fmt"
	"os"
	"path/filepath"
	"slices"
	"sort"
	"strings"
)

// Surfaces, in the order a full run executes them. desktop is last and
// serial because it binds a real window; cross is after the single-surface
// suites so that "cross fails while everything else is green" stays a
// readable signal.
var Order = []string{"meta", "backend", "tui", "ui", "cross", "desktop"}

// GoSurfaces are driven by `go test`; UI is driven by Playwright.
var GoSurfaces = []string{"backend", "tui", "desktop", "cross", "meta"}

// Selection is what to run. The zero value means "everything the config
// selects", which is what `amirotest run` with no flags resolves to.
type Selection struct {
	Surfaces     []string `json:"surfaces,omitempty"`
	Features     []string `json:"features,omitempty"`
	Grep         string   `json:"grep,omitempty"`
	TagsInclude  []string `json:"tagsInclude,omitempty"`
	TagsExclude  []string `json:"tagsExclude,omitempty"`
	Browsers     []string `json:"browsers,omitempty"`
	UpdateGolden bool     `json:"updateGolden,omitempty"`
}

func (s Selection) String() string {
	var parts []string
	if len(s.Surfaces) > 0 {
		parts = append(parts, "--surface "+strings.Join(s.Surfaces, ","))
	}
	if len(s.Features) > 0 {
		parts = append(parts, "--feature "+strings.Join(s.Features, ","))
	}
	if s.Grep != "" {
		parts = append(parts, fmt.Sprintf("--grep %q", s.Grep))
	}
	if len(s.TagsInclude) > 0 {
		parts = append(parts, "--tag "+strings.Join(s.TagsInclude, ","))
	}
	if s.UpdateGolden {
		parts = append(parts, "--update-golden")
	}
	if len(parts) == 0 {
		return "everything"
	}
	return strings.Join(parts, " ")
}

// Feature is one directory under suites/<surface>/ or ui/specs/.
type Feature struct {
	Surface string   `json:"surface"`
	Name    string   `json:"name"`
	Dir     string   `json:"dir"`
	Package string   `json:"package"` // ./suites/backend/chat, for `go test`
	Tests   []string `json:"tests,omitempty"`
}

// Address is the stable identity of one test: surface/feature/name.
func (f Feature) Address(test string) string {
	return f.Surface + "/" + f.Name + "/" + test
}

// Catalogue is everything discovered on disk.
type Catalogue struct {
	BaseDir  string    `json:"baseDir"`
	Features []Feature `json:"features"`
}

// Discover walks tests/ and builds the catalogue.
//
// A surface directory that does not exist yet is not an error: phases land
// one surface at a time, and `amirotest list` on a tree with only
// suites/backend/ should print what is there rather than complain about
// what is not.
func Discover(baseDir string) (*Catalogue, error) {
	cat := &Catalogue{BaseDir: baseDir}
	for _, surface := range GoSurfaces {
		root := filepath.Join(baseDir, "suites", surface)
		entries, err := os.ReadDir(root)
		if err != nil {
			if os.IsNotExist(err) {
				continue
			}
			return nil, err
		}
		// A surface directory holding test files DIRECTLY is its own single
		// feature. suites/meta/ is shaped that way: its guards are one flat
		// set of cross-cutting checks, and inventing sub-directories to
		// satisfy the convention would be filing for its own sake.
		if flat, err := goTestNamesFlat(root); err == nil && len(flat) > 0 {
			cat.Features = append(cat.Features, Feature{
				Surface: surface,
				Name:    surface,
				Dir:     root,
				Package: "./" + filepath.ToSlash(filepath.Join("suites", surface)),
				Tests:   flat,
			})
		}
		for _, e := range entries {
			if !e.IsDir() || strings.HasPrefix(e.Name(), ".") || e.Name() == "testdata" {
				continue
			}
			dir := filepath.Join(root, e.Name())
			tests, err := goTestNames(dir)
			if err != nil {
				return nil, err
			}
			cat.Features = append(cat.Features, Feature{
				Surface: surface,
				Name:    e.Name(),
				Dir:     dir,
				Package: "./" + filepath.ToSlash(filepath.Join("suites", surface, e.Name())) + "/...",
				Tests:   tests,
			})
		}
	}
	// The UI surface lives in ui/specs/, driven by Playwright rather than
	// `go test`, but addresses the same way.
	specsRoot := filepath.Join(baseDir, "ui", "specs")
	entries, err := os.ReadDir(specsRoot)
	if err == nil {
		for _, e := range entries {
			if !e.IsDir() || strings.HasPrefix(e.Name(), ".") {
				continue
			}
			dir := filepath.Join(specsRoot, e.Name())
			cat.Features = append(cat.Features, Feature{
				Surface: "ui",
				Name:    e.Name(),
				Dir:     dir,
				Package: filepath.ToSlash(filepath.Join("ui", "specs", e.Name())),
				Tests:   playwrightTitles(dir),
			})
		}
	} else if !os.IsNotExist(err) {
		return nil, err
	}

	sort.Slice(cat.Features, func(i, j int) bool {
		si := slices.Index(Order, cat.Features[i].Surface)
		sj := slices.Index(Order, cat.Features[j].Surface)
		if si != sj {
			return si < sj
		}
		return cat.Features[i].Name < cat.Features[j].Name
	})
	return cat, nil
}

// FeatureNames returns every known feature name, deduplicated, for the
// "unknown feature" error message.
func (c *Catalogue) FeatureNames() []string {
	seen := map[string]bool{}
	var out []string
	for _, f := range c.Features {
		if !seen[f.Name] {
			seen[f.Name] = true
			out = append(out, f.Name)
		}
	}
	sort.Strings(out)
	return out
}

// SurfaceNames returns the surfaces that actually have features on disk.
func (c *Catalogue) SurfaceNames() []string {
	seen := map[string]bool{}
	var out []string
	for _, f := range c.Features {
		if !seen[f.Surface] {
			seen[f.Surface] = true
			out = append(out, f.Surface)
		}
	}
	sort.Slice(out, func(i, j int) bool {
		return slices.Index(Order, out[i]) < slices.Index(Order, out[j])
	})
	return out
}

// Invocation is one runner command to execute.
type Invocation struct {
	Surface  string   `json:"surface"`
	Runner   string   `json:"runner"` // "go" or "playwright"
	Args     []string `json:"args"`
	Features []string `json:"features"`
	// Serial marks a surface that must not overlap with itself or with
	// anything else -- desktop binds a real window.
	Serial bool `json:"serial"`
}

// Resolve turns a selection into runner invocations, and reports which
// selected surfaces had nothing to run.
//
// An unknown feature is an error naming the valid ones, never a silent
// zero-test pass. That distinction is the difference between "there is no
// chat suite yet" and "you typed caht".
//
// The `empty` return exists for the other half of the same problem: a
// surface that was selected and contributed no tests must appear in the
// summary saying so. "ui: 0 tests" reading as green when there is no UI
// suite at all is the failure mode this whole package is arranged against.
func Resolve(sel Selection, cat *Catalogue) (invs []Invocation, empty []string, err error) {
	surfaces := sel.Surfaces
	if len(surfaces) == 0 {
		surfaces = cat.SurfaceNames()
	}
	for _, s := range surfaces {
		if !slices.Contains(Order, s) {
			return nil, nil, fmt.Errorf("unknown surface %q (valid: %s)", s, strings.Join(Order, ", "))
		}
	}
	if len(sel.Features) > 0 {
		known := cat.FeatureNames()
		var missing []string
		for _, f := range sel.Features {
			if !slices.Contains(known, f) {
				missing = append(missing, f)
			}
		}
		if len(missing) > 0 {
			msg := fmt.Sprintf("unknown feature %s", strings.Join(quoteAll(missing), ", "))
			if len(known) == 0 {
				return nil, nil, fmt.Errorf("%s: no features exist yet under suites/ or ui/specs/", msg)
			}
			return nil, nil, fmt.Errorf("%s (known features: %s)", msg, strings.Join(known, ", "))
		}
	}

	var invocations []Invocation
	for _, surface := range Order {
		if !slices.Contains(surfaces, surface) {
			continue
		}
		matched := matchFeatures(cat, surface, sel.Features)
		if len(matched) == 0 {
			// Not an error -- `--feature chat` across every surface
			// legitimately matches only some of them -- but recorded, so
			// the summary can say the surface contributed nothing.
			empty = append(empty, surface)
			continue
		}
		if surface == "ui" {
			invocations = append(invocations, playwrightInvocation(sel, matched))
			continue
		}
		invocations = append(invocations, goInvocation(surface, sel, matched))
	}
	if len(invocations) == 0 {
		return nil, empty, fmt.Errorf("selection %s matched no tests", sel.String())
	}
	return invocations, empty, nil
}

func matchFeatures(cat *Catalogue, surface string, want []string) []Feature {
	var out []Feature
	for _, f := range cat.Features {
		if f.Surface != surface {
			continue
		}
		if len(want) > 0 && !slices.Contains(want, f.Name) {
			continue
		}
		out = append(out, f)
	}
	return out
}

func goInvocation(surface string, sel Selection, features []Feature) Invocation {
	args := []string{"test"}
	names := make([]string, 0, len(features))
	pkgs := make([]string, 0, len(features))
	for _, f := range features {
		names = append(names, f.Name)
		pkgs = append(pkgs, f.Package)
	}
	args = append(args, pkgs...)
	if sel.Grep != "" {
		args = append(args, "-run", sel.Grep)
	}
	return Invocation{
		Surface:  surface,
		Runner:   "go",
		Args:     args,
		Features: names,
		Serial:   surface == "desktop",
	}
}

func playwrightInvocation(sel Selection, features []Feature) Invocation {
	args := []string{"playwright", "test"}
	names := make([]string, 0, len(features))
	for _, f := range features {
		names = append(names, f.Name)
		args = append(args, f.Package)
	}
	if sel.Grep != "" {
		args = append(args, "--grep", sel.Grep)
	}
	for _, b := range sel.Browsers {
		args = append(args, "--project", b)
	}
	return Invocation{Surface: "ui", Runner: "playwright", Args: args, Features: names}
}

// TagDecision answers, for a test that is already running, whether the
// current selection wants it.
//
// The reason is returned alongside the verdict because a skipped test must
// say why. A suite whose skips are invisible is a suite that reports green
// while running nothing.
type TagDecision struct {
	Run    bool
	Reason string
}

// Decide applies include/exclude tag rules to one test's tags.
//
// Include is an OR: a test carrying any included tag runs. Exclude wins
// over include, so `--tag slow` with the default exclusion of `slow` is a
// contradiction the caller must resolve by clearing the exclusion -- which
// cmd/amirotest does, since asking for a tag plainly means wanting it.
func Decide(tags []string, sel Selection) TagDecision {
	for _, t := range tags {
		if slices.Contains(sel.TagsExclude, t) {
			return TagDecision{Run: false, Reason: fmt.Sprintf("tagged %q, which run.tags.exclude excludes", t)}
		}
	}
	if len(sel.TagsInclude) == 0 {
		return TagDecision{Run: true}
	}
	for _, t := range tags {
		if slices.Contains(sel.TagsInclude, t) {
			return TagDecision{Run: true}
		}
	}
	return TagDecision{Run: false, Reason: fmt.Sprintf("does not carry any of the required tags: %s", strings.Join(sel.TagsInclude, ", "))}
}

func quoteAll(s []string) []string {
	out := make([]string, len(s))
	for i, v := range s {
		out[i] = fmt.Sprintf("%q", v)
	}
	return out
}

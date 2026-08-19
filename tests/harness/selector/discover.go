package selector

import (
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
)

// goTestFunc matches a top-level test function declaration. Deliberately a
// regexp over source text rather than a `go list`/parser pass: `amirotest
// list` must work on a tree that does not compile, which is exactly when
// someone is trying to find out what tests exist.
var goTestFunc = regexp.MustCompile(`(?m)^func (Test[A-Za-z0-9_]*)\(`)

func goTestNames(dir string) ([]string, error) {
	var names []string
	err := filepath.WalkDir(dir, func(path string, d os.DirEntry, err error) error {
		if err != nil {
			return err
		}
		if d.IsDir() {
			if d.Name() == "testdata" && path != dir {
				return filepath.SkipDir
			}
			return nil
		}
		if !strings.HasSuffix(d.Name(), "_test.go") {
			return nil
		}
		data, err := os.ReadFile(path)
		if err != nil {
			return err
		}
		for _, m := range goTestFunc.FindAllStringSubmatch(string(data), -1) {
			names = append(names, m[1])
		}
		return nil
	})
	if err != nil {
		return nil, err
	}
	sort.Strings(names)
	return names, nil
}

// playwrightTitle matches test("...") and test.describe("..."). Same
// reasoning as goTestFunc: a text scan works without a Node runtime
// installed, and `amirotest list` should not require one.
var playwrightTitle = regexp.MustCompile(`(?m)^\s*test(?:\.\w+)*\(\s*["'` + "`" + `]([^"'` + "`" + `]+)`)

func playwrightTitles(dir string) []string {
	var titles []string
	_ = filepath.WalkDir(dir, func(path string, d os.DirEntry, err error) error {
		if err != nil || d.IsDir() {
			return nil
		}
		if !strings.HasSuffix(d.Name(), ".spec.ts") && !strings.HasSuffix(d.Name(), ".spec.tsx") {
			return nil
		}
		data, err := os.ReadFile(path)
		if err != nil {
			return nil
		}
		for _, m := range playwrightTitle.FindAllStringSubmatch(string(data), -1) {
			titles = append(titles, m[1])
		}
		return nil
	})
	sort.Strings(titles)
	return titles
}

// goTestNamesFlat scans only the files directly in dir, not its
// subdirectories.
//
// The distinction matters for the flat-surface case: suites/backend/ has no
// test files of its own but its CHILDREN do, and a recursive scan there
// would invent a phantom "backend/backend" feature holding every test in
// the surface -- which would then double-count every address and make the
// uniqueness guard fail for a reason that is not real.
func goTestNamesFlat(dir string) ([]string, error) {
	entries, err := os.ReadDir(dir)
	if err != nil {
		return nil, err
	}
	var names []string
	for _, e := range entries {
		if e.IsDir() || !strings.HasSuffix(e.Name(), "_test.go") {
			continue
		}
		data, err := os.ReadFile(filepath.Join(dir, e.Name()))
		if err != nil {
			return nil, err
		}
		for _, m := range goTestFunc.FindAllStringSubmatch(string(data), -1) {
			names = append(names, m[1])
		}
	}
	sort.Strings(names)
	return names, nil
}

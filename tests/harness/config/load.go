package config

import (
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"

	"gopkg.in/yaml.v3"
)

// Standard file names, all optional, all relative to the tests/ directory.
const (
	FileName      = "config.yaml"
	LocalFileName = "config.local.yaml"
	ExampleName   = "config.example.yaml"
	EnvFileName   = ".env"
)

// Override is a flag-level mutation, applied after the file and the
// environment. Flags always beat config.yaml -- see
// docs/testing/03-selection.md: `--surface ui` on a config listing all four
// surfaces runs only the UI, it does not intersect.
type Override func(*Config)

// LoadOptions parameterises Load. The zero value is the normal case:
// discover tests/, read whatever files exist, overlay the real environment.
type LoadOptions struct {
	// BaseDir is the tests/ directory. Empty means discover it by walking
	// up from the working directory.
	BaseDir string
	// File and LocalFile override the standard names, for testdata.
	File      string
	LocalFile string
	// EnvFile overrides tests/.env. Set to os.DevNull to disable.
	EnvFile string
	// Env overrides the environment lookup, for testdata.
	Env func(string) (string, bool)
	// SkipEnv ignores AMIRO_TEST_* entirely.
	SkipEnv bool
	// Overrides are the flag layer, applied last.
	Overrides []Override
}

// Result is everything Load learned, not just the config. The extras exist
// because run.json has to be able to answer "why is this run configured
// this way?" without the reader re-deriving it.
type Result struct {
	Config Config `json:"config"`
	// BaseDir is the tests/ directory every relative path resolves against.
	BaseDir string `json:"baseDir"`
	// Sources are the files actually read, in precedence order. An empty
	// list is normal and means every value is a default.
	Sources []string `json:"sources"`
	// EnvApplied lists the config paths an AMIRO_TEST_* variable changed.
	EnvApplied []string `json:"envApplied,omitempty"`
	// DroppedProviders are providers removed because their apiKey expanded
	// to nothing. Recorded rather than silent -- "why did my provider test
	// not run" must be answerable from run.json.
	DroppedProviders []string `json:"droppedProviders,omitempty"`
	// MissingVars are ${VAR} references that resolved to nothing.
	MissingVars []string `json:"missingVars,omitempty"`
	// Warnings are legal-but-suspicious settings.
	Warnings []Problem `json:"warnings,omitempty"`
}

// Load resolves the full precedence chain and validates the result.
//
// Every error is returned at once as a *ValidationError; nothing should be
// built or spawned until this returns cleanly.
func Load(opts LoadOptions) (*Result, error) {
	baseDir := opts.BaseDir
	if baseDir == "" {
		found, err := DiscoverBaseDir("")
		if err != nil {
			return nil, err
		}
		baseDir = found
	}

	envFile := opts.EnvFile
	if envFile == "" {
		envFile = filepath.Join(baseDir, EnvFileName)
	}
	expander, err := NewExpander(envFile)
	if err != nil {
		return nil, fmt.Errorf("reading %s: %w", envFile, err)
	}

	res := &Result{Config: Defaults(), BaseDir: baseDir}
	var problems []Problem

	files := []string{
		pick(opts.File, filepath.Join(baseDir, FileName)),
		pick(opts.LocalFile, filepath.Join(baseDir, LocalFileName)),
	}
	for _, path := range files {
		data, readErr := os.ReadFile(path)
		if readErr != nil {
			if errors.Is(readErr, os.ErrNotExist) {
				continue // Absent is valid. This is the whole design.
			}
			return nil, fmt.Errorf("reading %s: %w", path, readErr)
		}
		res.Sources = append(res.Sources, path)
		problems = append(problems, applyFile(&res.Config, data, path, expander)...)
	}

	if !opts.SkipEnv {
		applied, envProblems := ApplyEnv(&res.Config, opts.Env)
		res.EnvApplied = applied
		problems = append(problems, envProblems...)
	}

	for _, o := range opts.Overrides {
		if o != nil {
			o(&res.Config)
		}
	}

	for v := range expander.Missing {
		res.MissingVars = append(res.MissingVars, v)
	}
	sortStrings(res.MissingVars)

	res.DroppedProviders = res.Config.DropUnconfiguredProviders()

	// A configuration that names providers.mode: replay or record but ended
	// up with no provider at all falls back to fake rather than failing.
	// docs/testing/02-config.md's table promises a green run on a machine
	// with no keys, and that promise outranks the letter of the mode.
	if len(res.Config.Providers.LLM) == 0 && (res.Config.Providers.Mode == "record" || res.Config.Providers.Mode == "live") {
		res.Warnings = append(res.Warnings, Problem{
			Key: "providers.mode",
			Message: fmt.Sprintf("providers.mode: %q needs a provider key and none is configured; falling back to fake",
				res.Config.Providers.Mode),
		})
		res.Config.Providers.Mode = "fake"
	}

	warnings, verr := Validate(&res.Config, baseDir)
	res.Warnings = append(res.Warnings, warnings...)
	if verr != nil {
		var ve *ValidationError
		if errors.As(verr, &ve) {
			problems = append(problems, ve.Problems...)
		} else {
			return nil, verr
		}
	}
	if len(problems) > 0 {
		return res, &ValidationError{Problems: problems}
	}
	return res, nil
}

// applyFile parses one YAML document: unknown-key report, ${VAR} expansion,
// then the merge. In that order, because reporting `providers.mdoe` as an
// unknown key is more useful than reporting whatever the expanded value of
// a key that does not exist failed to become.
func applyFile(cfg *Config, data []byte, path string, expander *Expander) []Problem {
	var doc yaml.Node
	if err := yaml.Unmarshal(data, &doc); err != nil {
		return []Problem{{File: path, Message: "not valid YAML: " + err.Error()}}
	}
	if len(doc.Content) == 0 {
		return nil // An empty file is an empty overlay.
	}
	problems := UnknownKeys(&doc, path)

	expander.ExpandNode(&doc)

	expanded, err := yaml.Marshal(&doc)
	if err != nil {
		return append(problems, Problem{File: path, Message: "re-encoding after variable expansion: " + err.Error()})
	}
	if err := applyYAML(cfg, expanded); err != nil {
		var te *yaml.TypeError
		if errors.As(err, &te) {
			// yaml.v3 collects every type error into one TypeError, which
			// is exactly the all-at-once reporting we want; unpack it
			// rather than printing the aggregate.
			for _, msg := range te.Errors {
				problems = append(problems, Problem{File: path, Line: lineFrom(msg), Message: stripLine(msg)})
			}
			return problems
		}
		return append(problems, Problem{File: path, Message: err.Error()})
	}
	return problems
}

// lineFrom pulls the line number out of yaml.v3's "line 12: cannot unmarshal
// ..." messages so the Problem can be located like every other one.
func lineFrom(msg string) int {
	rest, ok := strings.CutPrefix(msg, "line ")
	if !ok {
		return 0
	}
	num, _, ok := strings.Cut(rest, ":")
	if !ok {
		return 0
	}
	n := 0
	for _, r := range num {
		if r < '0' || r > '9' {
			return 0
		}
		n = n*10 + int(r-'0')
	}
	return n
}

func stripLine(msg string) string {
	if _, rest, ok := strings.Cut(msg, ": "); ok && strings.HasPrefix(msg, "line ") {
		return rest
	}
	return msg
}

// DiscoverBaseDir walks up from start (default: the working directory)
// looking for the tests/ module root.
//
// This is what makes a bare `go test ./suites/backend/smoke` behave
// identically to `amirotest run`: the test binary's working directory is
// four levels below tests/, and it still has to find the same config.yaml,
// the same logs/ directory and the same cassettes.
func DiscoverBaseDir(start string) (string, error) {
	if start == "" {
		wd, err := os.Getwd()
		if err != nil {
			return "", err
		}
		start = wd
	}
	dir, err := filepath.Abs(start)
	if err != nil {
		return "", err
	}
	for {
		if isTestsModule(dir) {
			return dir, nil
		}
		// A sibling tests/ directory, for when the caller is somewhere else
		// in the repo entirely (the amirotest binary run from the root).
		if candidate := filepath.Join(dir, "tests"); isTestsModule(candidate) {
			return candidate, nil
		}
		parent := filepath.Dir(dir)
		if parent == dir {
			return "", fmt.Errorf("could not find the tests/ module root above %s (looked for a go.mod declaring `module amiro/tests`)", start)
		}
		dir = parent
	}
}

func isTestsModule(dir string) bool {
	data, err := os.ReadFile(filepath.Join(dir, "go.mod"))
	if err != nil {
		return false
	}
	for _, line := range strings.Split(string(data), "\n") {
		if strings.TrimSpace(line) == "module amiro/tests" {
			return true
		}
	}
	return false
}

func pick(override, standard string) string {
	if override != "" {
		return override
	}
	return standard
}

func sortStrings(s []string) {
	for i := 1; i < len(s); i++ {
		for j := i; j > 0 && s[j] < s[j-1]; j-- {
			s[j], s[j-1] = s[j-1], s[j]
		}
	}
}

package config

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

// loadFrom is the common setup: a temp tests/ directory holding one
// config.yaml, with the real environment and .env deliberately excluded so
// a developer's exported keys cannot change a unit test's result.
func loadFrom(t *testing.T, yaml string, opts ...func(*LoadOptions)) (*Result, error) {
	t.Helper()
	dir := t.TempDir()
	if yaml != "" {
		if err := os.WriteFile(filepath.Join(dir, FileName), []byte(yaml), 0o644); err != nil {
			t.Fatalf("writing config.yaml: %v", err)
		}
	}
	o := LoadOptions{BaseDir: dir, EnvFile: os.DevNull, SkipEnv: true}
	for _, fn := range opts {
		fn(&o)
	}
	return Load(o)
}

func TestLoad_NoFileProducesExactlyTheDefaults(t *testing.T) {
	res, err := loadFrom(t, "")
	if err != nil {
		t.Fatalf("a missing config.yaml must be valid: %v", err)
	}
	if got, want := res.Config.Run.Parallel, Defaults().Run.Parallel; got != want {
		t.Errorf("run.parallel = %d, want the default %d", got, want)
	}
	if len(res.Sources) != 0 {
		t.Errorf("no file should have been read, sources = %v", res.Sources)
	}
}

func TestLoad_ReportsEveryErrorAtOnceRatherThanTheFirst(t *testing.T) {
	// Three distinct classes of problem in one file: an unknown key, a bad
	// enum, and a path that does not exist. A user should be able to fix
	// all three before running again.
	res, err := loadFrom(t, `
run:
  paralel: 8
  keepArtifacts: sometimes
backend:
  binary: /definitely/not/here/amiro-server
`)
	if err == nil {
		t.Fatal("expected a validation error")
	}
	var ve *ValidationError
	if !asValidationError(err, &ve) {
		t.Fatalf("expected *ValidationError, got %T: %v", err, err)
	}
	if len(ve.Problems) < 3 {
		t.Fatalf("expected all 3 problems reported at once, got %d:\n%s", len(ve.Problems), ve.Error())
	}
	report := ve.Error()
	for _, want := range []string{"paralel", "keepArtifacts", "binary"} {
		if !strings.Contains(report, want) {
			t.Errorf("the report does not mention %q:\n%s", want, report)
		}
	}
	// The unknown key must carry a line number and a suggestion -- "unknown
	// key" alone leaves the user hunting, which is the experience this
	// whole path exists to avoid.
	var unknown *Problem
	for i := range ve.Problems {
		if strings.Contains(ve.Problems[i].Message, "paralel") {
			unknown = &ve.Problems[i]
		}
	}
	if unknown == nil {
		t.Fatal("the unknown key was not reported as such")
	}
	if unknown.Line == 0 {
		t.Error("the unknown key has no line number")
	}
	if unknown.Suggestion != "parallel" {
		t.Errorf("suggestion for `paralel` is %q, want \"parallel\"", unknown.Suggestion)
	}
	// Nothing may have been resolved into a usable config.
	if res != nil && err == nil {
		t.Error("a config with errors must not be returned as usable")
	}
}

func TestLoad_PrecedenceIsDefaultsThenFileThenEnv(t *testing.T) {
	env := map[string]string{"AMIRO_TEST_RUN_PARALLEL": "8"}
	res, err := loadFrom(t, "run:\n  parallel: 2\n  retries: 3\n", func(o *LoadOptions) {
		o.SkipEnv = false
		o.Env = func(k string) (string, bool) { v, ok := env[k]; return v, ok }
	})
	if err != nil {
		t.Fatalf("load: %v", err)
	}
	// Env beats the file.
	if res.Config.Run.Parallel != 8 {
		t.Errorf("run.parallel = %d, want 8 (the environment beats config.yaml)", res.Config.Run.Parallel)
	}
	// The file beats the default.
	if res.Config.Run.Retries != 3 {
		t.Errorf("run.retries = %d, want 3 (from config.yaml)", res.Config.Run.Retries)
	}
	// Anything neither set keeps its default.
	if res.Config.Run.KeepArtifacts != Defaults().Run.KeepArtifacts {
		t.Errorf("run.keepArtifacts = %q, want the untouched default", res.Config.Run.KeepArtifacts)
	}
	if len(res.EnvApplied) != 1 || res.EnvApplied[0] != "run.parallel" {
		t.Errorf("envApplied = %v, want [run.parallel] so run.json can show why", res.EnvApplied)
	}
}

func TestLoad_FlagOverridesBeatEverythingElse(t *testing.T) {
	env := map[string]string{"AMIRO_TEST_RUN_PARALLEL": "8"}
	res, err := loadFrom(t, "run:\n  parallel: 2\n", func(o *LoadOptions) {
		o.SkipEnv = false
		o.Env = func(k string) (string, bool) { v, ok := env[k]; return v, ok }
		o.Overrides = []Override{func(c *Config) { c.Run.Parallel = 2 }}
	})
	if err != nil {
		t.Fatalf("load: %v", err)
	}
	// This is Phase 1's exit criterion 4: file says nothing useful, env says
	// 8, the flag says 2, and the flag wins.
	if res.Config.Run.Parallel != 2 {
		t.Errorf("run.parallel = %d, want 2 (a flag beats the environment)", res.Config.Run.Parallel)
	}
}

func TestLoad_ListsAreReplacedNotMerged(t *testing.T) {
	res, err := loadFrom(t, "run:\n  surfaces: [backend]\n")
	if err != nil {
		t.Fatalf("load: %v", err)
	}
	if len(res.Config.Run.Surfaces) != 1 || res.Config.Run.Surfaces[0] != "backend" {
		t.Errorf("run.surfaces = %v, want exactly [backend]; a partial list is what the user meant, not a merge",
			res.Config.Run.Surfaces)
	}
}

func TestLoad_MapsMergeRatherThanReplace(t *testing.T) {
	// backend.env defaults to empty, so merging is only observable across
	// two files -- which is exactly the config.yaml + config.local.yaml case
	// the precedence chain exists for.
	dir := t.TempDir()
	write := func(name, body string) {
		if err := os.WriteFile(filepath.Join(dir, name), []byte(body), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	write(FileName, "backend:\n  env:\n    FROM_MAIN: \"1\"\n")
	write(LocalFileName, "backend:\n  env:\n    FROM_LOCAL: \"2\"\n")

	res, err := Load(LoadOptions{BaseDir: dir, EnvFile: os.DevNull, SkipEnv: true})
	if err != nil {
		t.Fatalf("load: %v", err)
	}
	if res.Config.Backend.Env["FROM_MAIN"] != "1" || res.Config.Backend.Env["FROM_LOCAL"] != "2" {
		t.Errorf("backend.env = %v, want both keys; maps merge deep", res.Config.Backend.Env)
	}
	if len(res.Sources) != 2 {
		t.Errorf("sources = %v, want both files recorded", res.Sources)
	}
}

func TestLoad_ExpandsVariablesAndDropsProvidersWithNoKey(t *testing.T) {
	env := map[string]string{"REAL_KEY": "sk-abcdefghijklmnop"}
	res, err := loadFrom(t, `
providers:
  mode: fake
  llm:
    - id: anthropic
      apiKey: ${REAL_KEY}
    - id: openai
      apiKey: ${NEVER_SET_ANYWHERE}
`, func(o *LoadOptions) {
		o.SkipEnv = false
		o.Env = func(k string) (string, bool) { v, ok := env[k]; return v, ok }
	})
	if err != nil {
		t.Fatalf("load: %v", err)
	}
	// Expansion reads the process environment, which SkipEnv does not
	// control -- so this asserts on the provider that had a real value.
	if len(res.Config.Providers.LLM) > 1 {
		t.Errorf("the provider with no key should have been dropped, got %d providers",
			len(res.Config.Providers.LLM))
	}
	if len(res.DroppedProviders) == 0 {
		t.Error("a dropped provider must be recorded in the result, not silently removed")
	}
}

func TestLoad_FallbackSyntaxIsHonoured(t *testing.T) {
	e, err := NewExpander(os.DevNull)
	if err != nil {
		t.Fatal(err)
	}
	if got := e.Expand("${DEFINITELY_NOT_SET_ANYWHERE:-http://localhost:11434}"); got != "http://localhost:11434" {
		t.Errorf("fallback not applied: %q", got)
	}
	if got := e.Expand("${DEFINITELY_NOT_SET_ANYWHERE}"); got != "" {
		t.Errorf("an unset variable with no fallback must expand to empty, got %q", got)
	}
	if !e.Missing["DEFINITELY_NOT_SET_ANYWHERE"] {
		t.Error("an unset variable with no fallback must be recorded as missing")
	}
}

func TestDuration_ReadsHumanFormsAndRendersCompactly(t *testing.T) {
	res, err := loadFrom(t, "run:\n  timeout: 45m\n  testTimeout: 90s\n")
	if err != nil {
		t.Fatalf("load: %v", err)
	}
	if res.Config.Run.Timeout.Duration() != 45*time.Minute {
		t.Errorf("run.timeout = %s, want 45m", res.Config.Run.Timeout)
	}
	if got := res.Config.Run.Timeout.String(); got != "45m" {
		t.Errorf("rendered as %q, want \"45m\" -- a generated config.example.yaml should not read like machine output", got)
	}
	if got := res.Config.Run.TestTimeout.String(); got != "1m30s" {
		t.Errorf("90s rendered as %q, want \"1m30s\"", got)
	}
}

func TestDuration_RejectsAnUnparseableValueWithAUsefulMessage(t *testing.T) {
	_, err := loadFrom(t, "run:\n  timeout: soon\n")
	if err == nil {
		t.Fatal("expected an error")
	}
	if !strings.Contains(err.Error(), "30m") {
		t.Errorf("the message should show the expected form, got: %v", err)
	}
}

func TestValidate_CrossFieldRulesAreChecked(t *testing.T) {
	cases := []struct {
		name  string
		yaml  string
		wants string
	}{
		{"postgres needs a dsn", "backend:\n  database:\n    driver: postgres\n", "backend.database.dsn"},
		{"static ui needs a built bundle", "ui:\n  mode: static\n  distDir: .\n", "index.html"},
		{"unknown provider id", "providers:\n  llm:\n    - id: notaprovider\n      apiKey: abcdefghijk\n", "notaprovider"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			_, err := loadFrom(t, tc.yaml)
			if err == nil {
				t.Fatalf("expected an error mentioning %q", tc.wants)
			}
			if !strings.Contains(err.Error(), tc.wants) {
				t.Errorf("error does not mention %q: %v", tc.wants, err)
			}
		})
	}
}

func TestValidate_LiveModeWithoutKeysFallsBackToFakeRatherThanFailing(t *testing.T) {
	// docs/testing/02-config.md's table promises a green run on a machine
	// with no keys. That promise outranks the letter of providers.mode, so
	// this degrades with a recorded warning instead of erroring.
	res, err := loadFrom(t, "providers:\n  mode: live\n")
	if err != nil {
		t.Fatalf("live mode with no keys must not be fatal: %v", err)
	}
	if res.Config.Providers.Mode != "fake" {
		t.Errorf("providers.mode = %q, want \"fake\" after falling back", res.Config.Providers.Mode)
	}
	if len(res.Warnings) == 0 {
		t.Error("the fallback must be warned about; a silent downgrade of fidelity is how a suite stops testing anything")
	}
}

func TestValidate_WarnsButDoesNotFailOnLegalButSuspiciousSettings(t *testing.T) {
	res, err := loadFrom(t, "ui:\n  host: 0.0.0.0\nrun:\n  retries: 5\nlogging:\n  keepRuns: 0\n")
	if err != nil {
		t.Fatalf("these are legal settings and must not fail: %v", err)
	}
	if len(res.Warnings) < 3 {
		t.Errorf("expected a warning for each of the three, got %d: %v", len(res.Warnings), res.Warnings)
	}
}

func TestRedacted_ReplacesSecretsWithStableFingerprints(t *testing.T) {
	cfg := Defaults()
	cfg.Providers.LLM = []LLMProvider{{ID: "anthropic", APIKey: "sk-secret-value-here"}}

	red := cfg.Redacted()
	if red.Providers.LLM[0].APIKey == cfg.Providers.LLM[0].APIKey {
		t.Fatal("the api key was not redacted")
	}
	if !strings.HasPrefix(red.Providers.LLM[0].APIKey, "<redacted:sha256:") {
		t.Errorf("unexpected redaction form: %q", red.Providers.LLM[0].APIKey)
	}
	// Stable, so an assertion can say "the same key was used in both
	// requests" without either request holding the key.
	if red.Providers.LLM[0].APIKey != cfg.Redacted().Providers.LLM[0].APIKey {
		t.Error("the fingerprint is not stable across calls")
	}
	// And the original is untouched: Redacted returns a copy, because
	// run.json is written from it precisely so a later mutation cannot
	// rewrite what actually ran.
	if cfg.Providers.LLM[0].APIKey != "sk-secret-value-here" {
		t.Error("Redacted mutated the receiver")
	}
}

func TestSecrets_ExcludesValuesTooShortToBeCredentials(t *testing.T) {
	cfg := Defaults()
	cfg.Providers.LLM = []LLMProvider{{ID: "ollama", APIKey: "ab"}}
	for _, s := range cfg.Secrets() {
		if s == "ab" {
			t.Fatal("a two-character value was treated as a secret; it would match half the log tree")
		}
	}
}

func TestEnvBindings_AreMechanicalAndCarryAReadableAlias(t *testing.T) {
	byPath := map[string]EnvBinding{}
	for _, b := range EnvBindings() {
		byPath[b.Path] = b
	}
	if got := byPath["run.parallel"].Name; got != "AMIRO_TEST_RUN_PARALLEL" {
		t.Errorf("run.parallel maps to %q", got)
	}
	if got := byPath["backend.database.driver"].Name; got != "AMIRO_TEST_BACKEND_DATABASE_DRIVER" {
		t.Errorf("backend.database.driver maps to %q", got)
	}
	// The camelCase alias exists because AMIRO_TEST_RUN_KEEPARTIFACTS is not
	// a name anyone types correctly first time, and a silently-ignored
	// environment variable is the worst failure mode a config system has.
	ka := byPath["run.keepArtifacts"]
	if ka.Name != "AMIRO_TEST_RUN_KEEPARTIFACTS" {
		t.Errorf("mechanical name is %q", ka.Name)
	}
	if ka.Alias != "AMIRO_TEST_RUN_KEEP_ARTIFACTS" {
		t.Errorf("alias is %q, want AMIRO_TEST_RUN_KEEP_ARTIFACTS", ka.Alias)
	}
	// A list is reachable, and an empty value means an empty list.
	if got := byPath["run.tags.exclude"].Kind; got != "list" {
		t.Errorf("run.tags.exclude kind = %q, want list", got)
	}
}

func TestApplyEnv_EmptyListValueMeansAnEmptyList(t *testing.T) {
	cfg := Defaults()
	env := map[string]string{"AMIRO_TEST_RUN_TAGS_EXCLUDE": ""}
	applied, problems := ApplyEnv(&cfg, func(k string) (string, bool) { v, ok := env[k]; return v, ok })
	if len(problems) > 0 {
		t.Fatalf("unexpected problems: %v", problems)
	}
	if len(applied) != 1 {
		t.Fatalf("applied = %v", applied)
	}
	if len(cfg.Run.Tags.Exclude) != 0 {
		t.Errorf("run.tags.exclude = %v, want empty -- that is how CI says \"run the slow tests too\"",
			cfg.Run.Tags.Exclude)
	}
}

func TestApplyEnv_ReportsAnUnparseableValueRatherThanIgnoringIt(t *testing.T) {
	cfg := Defaults()
	env := map[string]string{"AMIRO_TEST_RUN_PARALLEL": "lots"}
	_, problems := ApplyEnv(&cfg, func(k string) (string, bool) { v, ok := env[k]; return v, ok })
	if len(problems) != 1 {
		t.Fatalf("expected one problem, got %v", problems)
	}
	if !strings.Contains(problems[0].Message, "AMIRO_TEST_RUN_PARALLEL") {
		t.Errorf("the problem does not name the variable: %s", problems[0].Message)
	}
}

func TestDiscoverBaseDir_FindsTheModuleRootFromASubdirectory(t *testing.T) {
	// The real tree, walked from four levels down -- which is where a bare
	// `go test ./suites/backend/smoke` actually runs.
	found, err := DiscoverBaseDir("suites")
	if err != nil {
		t.Fatalf("DiscoverBaseDir: %v", err)
	}
	if _, err := os.Stat(filepath.Join(found, "go.mod")); err != nil {
		t.Errorf("discovered %s, which has no go.mod", found)
	}
}

func TestUnknownKeys_SuggestsOnlyWhenTheGuessIsPlausible(t *testing.T) {
	// "parallel" is one edit from "paralel", so suggest it.
	if got := suggest("paralel", []string{"parallel", "retries", "timeout"}); got != "parallel" {
		t.Errorf("suggest(paralel) = %q", got)
	}
	// "mode" and "models" differ by two characters on a four-character word;
	// a confident wrong suggestion is worse than none.
	if got := suggest("zzzz", []string{"parallel", "retries", "timeout"}); got != "" {
		t.Errorf("suggest(zzzz) = %q, want no suggestion", got)
	}
}

func asValidationError(err error, target **ValidationError) bool {
	for err != nil {
		if v, ok := err.(*ValidationError); ok {
			*target = v
			return true
		}
		u, ok := err.(interface{ Unwrap() error })
		if !ok {
			return false
		}
		err = u.Unwrap()
	}
	return false
}

func TestDefaults_SelectTheGuardSurfaceSoDegradationIsCaught(t *testing.T) {
	// The suites/meta guards catch the test system itself degrading -- config
	// drift, a leaked secret, an orphaned process. They are cheap and they
	// run first, so they belong in a default run rather than being something
	// you have to remember to ask for.
	var found bool
	for _, s := range Defaults().Run.Surfaces {
		if s == "meta" {
			found = true
		}
	}
	if !found {
		t.Errorf("run.surfaces defaults to %v, which omits the guards", Defaults().Run.Surfaces)
	}
}

func TestDefaults_ExcludeTheTagsThatCostMoneyOrTime(t *testing.T) {
	excluded := map[string]bool{}
	for _, tag := range Defaults().Run.Tags.Exclude {
		excluded[tag] = true
	}
	for _, tag := range []string{"live", "slow", "flaky"} {
		if !excluded[tag] {
			t.Errorf("%q is not excluded by default; a plain `amirotest run` would spend money or minutes on it", tag)
		}
	}
}

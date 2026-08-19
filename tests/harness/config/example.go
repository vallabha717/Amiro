package config

import (
	"fmt"
	"reflect"
	"strings"

	"gopkg.in/yaml.v3"
)

// Example renders config.example.yaml from Defaults().
//
// The committed tests/config.example.yaml is this function's output, and
// suites/meta/config_drift_test.go fails when the two differ. That is the
// mechanism that keeps "the documented default" and "the actual default"
// from separating -- the usual way a config file's comments become lies is
// that nobody regenerates them.
//
// Regenerate with: amirotest config example
// Check without writing: amirotest config example --check
func Example() string {
	var b strings.Builder
	b.WriteString(exampleHeader)
	d := Defaults()
	v := reflect.ValueOf(d)
	t := v.Type()
	for i := 0; i < t.NumField(); i++ {
		name := yamlName(t.Field(i))
		writeBanner(&b, name)
		emit(&b, name, name, v.Field(i), 0)
	}
	return b.String()
}

const exampleHeader = `# ============================================================================
# tests/config.example.yaml
#
# GENERATED FROM harness/config/defaults.go BY ` + "`amirotest config example`" + `.
# Do not edit by hand -- edit defaults.go and the doc table in example.go,
# then regenerate. suites/meta fails the build if this file has drifted.
#
# Copy to tests/config.yaml and edit. config.yaml is gitignored.
#
# EVERY KEY IS OPTIONAL. Anything you leave out uses the default shown here.
# Deleting this file entirely is a valid configuration -- the suite then runs
# with fake providers, a sqlite database and a chromium browser, and passes
# with no API keys and no network.
#
# ${VAR} anywhere in a string is expanded from the environment (and from a
# tests/.env file if present). ${VAR:-fallback} is supported. An unset
# variable with no fallback becomes "", which means "not configured" -- a
# provider whose apiKey ends up empty is dropped, and run.json records that
# it was.
#
# Anything here can also be set from the environment without touching the
# file: AMIRO_TEST_<PATH>, e.g. AMIRO_TEST_RUN_PARALLEL=8 or
# AMIRO_TEST_PROVIDERS_MODE=live. Run ` + "`amirotest env --list`" + ` for the full map.
# ============================================================================
`

func writeBanner(b *strings.Builder, section string) {
	title, ok := sectionTitles[section]
	if !ok {
		title = section
	}
	b.WriteString("\n\n")
	b.WriteString("# ---------------------------------------------------------------------------\n")
	fmt.Fprintf(b, "# %s\n", title)
	b.WriteString("# ---------------------------------------------------------------------------\n")
}

// emit writes one key. Structs recurse; everything else prints its doc
// block, its default, and the value.
func emit(b *strings.Builder, path, name string, v reflect.Value, indent int) {
	pad := strings.Repeat(" ", indent)

	if v.Kind() == reflect.Struct && v.Type() != reflect.TypeOf(Duration(0)) {
		if indent > 0 {
			// Nested sections get their own breathing room even when they
			// carry no prose, so `tags:` does not read as part of the key
			// above it.
			b.WriteString("\n")
		}
		writeDoc(b, path, pad, "")
		fmt.Fprintf(b, "%s%s:\n", pad, name)
		t := v.Type()
		for i := 0; i < t.NumField(); i++ {
			child := yamlName(t.Field(i))
			emit(b, path+"."+child, child, v.Field(i), indent+2)
		}
		return
	}

	rendered := render(v)
	writeDoc(b, path, pad, rendered)
	fmt.Fprintf(b, "%s%s: %s\n", pad, name, rendered)
}

func writeDoc(b *strings.Builder, path, pad, def string) {
	lines := docs[path]
	if lines == "" && def == "" {
		return
	}
	if def != "" {
		b.WriteString("\n")
	}
	if lines != "" {
		for _, line := range strings.Split(strings.TrimRight(lines, "\n"), "\n") {
			if line == "" {
				fmt.Fprintf(b, "%s#\n", pad)
				continue
			}
			fmt.Fprintf(b, "%s# %s\n", pad, line)
		}
	}
	if def != "" {
		fmt.Fprintf(b, "%s# default: %s\n", pad, def)
	}
}

// render formats a default value as the YAML the user would type. Lists use
// flow style because a five-element list of surface names reads better on
// one line than as five bullets, and empty containers render as [] / {} so
// that the shape of the key is visible even when it has no content.
func render(v reflect.Value) string {
	if v.Type() == reflect.TypeOf(Duration(0)) {
		return v.Interface().(Duration).String()
	}
	switch v.Kind() {
	case reflect.Slice:
		if v.Len() == 0 {
			return "[]"
		}
		parts := make([]string, v.Len())
		for i := range parts {
			parts[i] = render(v.Index(i))
		}
		return "[" + strings.Join(parts, ", ") + "]"
	case reflect.Map:
		if v.Len() == 0 {
			return "{}"
		}
	case reflect.Float64:
		return fmt.Sprintf("%.2f", v.Float())
	}
	out, err := yaml.Marshal(v.Interface())
	if err != nil {
		return ""
	}
	return strings.TrimRight(string(out), "\n")
}

var sectionTitles = map[string]string{
	"run":       "run -- what to execute and how",
	"providers": "providers -- LLM and search credentials, and how the suite talks to them",
	"backend":   "backend -- the Go server under test",
	"tui":       "tui -- the amiro terminal client",
	"ui":        "ui -- the web dashboard",
	"desktop":   "desktop -- the Tauri shell",
	"logging":   "logging -- the run directory and what goes in it",
	"accounts":  "accounts -- the identities every suite signs in as",
	"mcp":       "mcp -- the MCP server the suite connects to",
}

// docs is the prose half of config.example.yaml. It lives here rather than
// in struct tags because these are paragraphs, not labels, and a struct tag
// holding four sentences is unreadable in the type it is documenting.
var docs = map[string]string{
	"run.id":              "Empty means mint one: <UTC RFC3339>-<6 chars>, e.g.\n2026-08-19T14-32-05Z-a1b2c3. Set it to re-use a run directory.",
	"run.surfaces":        "Which surfaces to run. desktop skips itself when the Tauri\ntoolchain is absent -- see desktop.enabled.\nValid: backend, tui, ui, desktop, cross, meta.",
	"run.features":        "Empty means every feature of every selected surface. Names are\nthe directory names under suites/<surface>/ and ui/specs/.\n`amirotest list` prints them all.",
	"run.tags.include":    "Empty means no tag is required for a test to run.",
	"run.tags.exclude":    "Tests carrying any of these are skipped, with the reason\nrecorded in the summary rather than silently passing.",
	"run.parallel":        "Workers per surface. Each gets its own database, workspace,\napp-data directory and port, so this is safe to raise.",
	"run.timeout":         "Whole-run deadline.",
	"run.testTimeout":     "Per-test deadline.",
	"run.keepArtifacts":   "always | on-failure | never\nControls videos, HAR files, database snapshots and frame dumps.\nrun.json, summary.* and events.ndjson are ALWAYS kept.",
	"run.failFast":        "Stop at the first failure instead of running everything and\nreporting everything.",
	"run.retries":         "Reruns a failed test N times before declaring failure. Every\nattempt is kept as attempt-1/, attempt-2/, ... CI should use 0:\na retry that turns a run green hides a race.",
	"run.strictCassettes": "false -- a request with no matching cassette falls back to fake\n        mode, logs a miss, and reports degraded fidelity.\ntrue  -- a cassette miss FAILS the test, naming the cassette that\n        would have been written and the command to record it.\nThis is what stops cassette rot from quietly turning the whole\nsuite into fake mode. CI should set it true.",
	"run.costCeilingUsd":  "USD ceiling for a live or record run; exceeding it fails the\nrun. Ignored in replay and fake mode, where spend is always 0.",

	"providers.mode":        "replay -- serve recorded traffic from cassetteDir. No network,\n          no cost.\nrecord -- call the real API and write cassettes. Needs real keys.\nlive   -- call the real API, write nothing.\nfake   -- never touch a cassette or the network; a deterministic\n          canned stream answers instead. This is what runs when\n          you have no keys at all.",
	"providers.cassetteDir": "Relative to tests/.",
	"providers.default":     "Used wherever a test does not name a model explicitly.",
	"providers.llm":         "LLM providers. Ids match backend-go/internal/ai/bifrost/catalog.go:\nopenai, google, anthropic, xai, groq, openRouter -- plus ollama\nfor a local endpoint. Empty means fake mode.\n\n  llm:\n    - id: anthropic\n      apiKey: ${ANTHROPIC_API_KEY}\n      baseUrl: \"\"              # \"\" = the provider's official URL\n      models: [claude-sonnet-5]  # [] = whatever the provider advertises\n    - id: ollama\n      baseUrl: http://localhost:11434/api\n      models: [qwen3:8b]\n\nAn entry whose apiKey expands to nothing is dropped, and run.json\nrecords that it was -- so listing six providers on a machine with\none key exported does the obvious thing.",
	"providers.search":      "Web-search providers. Ids match backend-go/internal/search/registry.go:\nexa, tavily, brave, serper.\n\n  search:\n    - id: exa\n      apiKey: ${EXA_API_KEY}",
	"providers.redact":      "Header and JSON field names whose values are replaced with\n<redacted:sha256:8chars> in every log, cassette and HAR file.\nRedaction happens at write time, not as a later pass: a secret\nthat reaches disk once has leaked.",

	"backend.binary":                 "\"\" means build backend-go/cmd/server from source and cache it by\nsource hash. Set a path to skip the build -- this is what CI does.",
	"backend.bindHost":               "",
	"backend.port":                   "0 means let the OS assign, and the harness reads the real port\noff the PORT= line the server prints on stdout. Pin only for\nmanual debugging; a fixed port cannot run in parallel.",
	"backend.database.driver":        "sqlite | postgres",
	"backend.database.dsn":           "\"\" means <runDir>/backend/<test-id>/db/amiro.db for sqlite.\nRequired for postgres, where the harness creates and drops one\nschema per test.",
	"backend.database.keepOnSuccess": "Keep the database file after a passing test too, not just a\nfailing one.",
	"backend.workspaceRoot":          "\"\" means a per-test COPY of fixtures/workspaces/basic. Tests that\nexercise the agent's file tools always get their own copy, so\nnothing one test writes is visible to another.",
	"backend.env":                    "Extra AMIRO_* variables merged into every spawned backend.",
	"backend.startupTimeout":         "How long to wait for PORT= plus a healthy /health.",

	"tui.binary":          "\"\" means build backend-go/cmd/amiro from source and cache it.",
	"tui.terminal.width":  "Golden frames are captured at this size, so changing it\ninvalidates every golden file under suites/tui/**/testdata/.",
	"tui.terminal.height": "",
	"tui.terminal.term":   "",
	"tui.recordCasts":     "Write an asciinema .cast per test, replayable with\n`asciinema play logs/latest/tui/<test>/session.cast`.",
	"tui.goldenUpdate":    "true REWRITES golden frames instead of comparing them, so no\nrendering assertion can fail. Never set this in a committed\nconfig or in CI -- use `amirotest run --surface tui --update-golden`\nfor the one run where you mean it.",
	"tui.settleTimeout":   "How long to wait for the screen to stop changing before\ncapturing a frame for comparison.",

	"ui.mode":            "embedded -- `amiro serve` serves the go:embed'ed bundle. This is\n            the shipped path and should stay the default.\nstatic   -- serve a prebuilt directory (ui.distDir) over plain HTTP.\ndev      -- point Playwright at a running `next dev`. Fast to\n            iterate on; does NOT test the shipped bundle.",
	"ui.baseUrl":         "\"\" means derive it from the server the harness started. Set it to\ntest against something already running.",
	"ui.host":            "0.0.0.0 exercises the reachable-from-the-network path and its\nwarning banner. It also makes the dashboard reachable from every\nhost on the network, and Amiro runs shell commands.",
	"ui.port":            "0 means OS-assigned.",
	"ui.distDir":         "Only used by ui.mode: static. Relative to tests/.",
	"ui.browsers":        "chromium | firefox | webkit",
	"ui.headed":          "",
	"ui.viewport.width":  "",
	"ui.viewport.height": "",
	"ui.video":           "on | off | retain-on-failure",
	"ui.trace":           "on | off | retain-on-failure\nAlways produces the trace.zip you open with\n`pnpm exec playwright show-trace <path>` -- DOM snapshots,\nnetwork, console and a per-action timeline. Worth keeping on.",
	"ui.screenshot":      "on | off | only-on-failure",
	"ui.har":             "on | off | retain-on-failure -- network.har alongside the trace",

	"desktop.enabled":        "auto  -- run the suite only if cargo and the Tauri CLI are on\n        PATH; otherwise skip with a reason in the summary, not a\n        failure.\ntrue  -- always run it; a missing toolchain is then a failure.\nfalse -- never run it.",
	"desktop.binary":         "\"\" means `cargo tauri dev` from src-tauri/.",
	"desktop.mode":           "dev | bundled\nbundled builds a real installer and drives the installed app.\nSlow, so it is tagged `slow` and out of the default run.",
	"desktop.startupTimeout": "Tauri dev builds are not fast.",

	"logging.dir":          "Relative to tests/. One directory per run, plus a `latest`\nsymlink to the newest.",
	"logging.level":        "debug | info | warn | error\ndebug adds full request/response bodies and per-frame TUI dumps.",
	"logging.httpBodies":   "Record request/response bodies in backend/http.ndjson (redacted).",
	"logging.maxBodyBytes": "Bodies larger than this are truncated with a marker.",
	"logging.keepRuns":     "Delete run directories older than the newest N. 0 disables\npruning, and logs/ then grows without bound.",

	"accounts":                "The FIRST account registered against a fresh database becomes the\nadmin (backend-go/internal/auth), so the harness always registers\nadmin first. A test that wants to verify that rule opts out of\nseeding with harness.NoSeed() and registers by hand.\n\n`other` is a second non-admin, used for every \"can B see A's\ndata?\" test.",
	"accounts.admin.email":    "",
	"accounts.admin.password": "",
	"accounts.user.email":     "",
	"accounts.user.password":  "",
	"accounts.other.email":    "",
	"accounts.other.password": "",

	"mcp.useFixtureServer": "Start fixtures/mcp/server -- a real stdio MCP server with\ndeterministic tools -- so MCP tests exercise the real protocol\nrather than a mock of Amiro's own client.",
	"mcp.external":         "Extra real MCP servers to connect to. Anything here is tagged\n`live` and excluded from the default run.\n\n  external:\n    - name: github\n      command: npx\n      args: [-y, \"@modelcontextprotocol/server-github\"]",
}

package backend

import (
	"fmt"
	"runtime"
	"sort"

	"amiro/tests/harness/config"
	"amiro/tests/harness/process"
)

// Paths are the per-test directories a backend is confined to. Every one of
// them lives inside the run directory, so a failed test's entire world is
// preserved and a passing test's world is cheap to delete.
type Paths struct {
	AppDataDir    string
	WorkspaceRoot string
	Home          string
	DatabaseDSN   string
}

// Env builds the environment for a spawned backend.
//
// This function is the ONLY place in the test system that knows the
// application's variable names (docs/testing/02-config.md). Everything else
// speaks in terms of resolved config; the translation happens once, here,
// so a rename in the app is a one-file change in the harness.
//
// It starts from process.InheritSafe, which strips every AMIRO_* and
// BETTERCHATBOT_* variable out of the parent environment. A spawned backend
// must never inherit the developer's own AMIRO_APP_DATA_DIR -- that is how
// a test suite writes into a real database, and it is not a hypothetical:
// it happened once during Phase 0 and was caught only because
// /api/auth/status answered "isFirstUser: false" against what was supposed
// to be an empty database.
func Env(cfg *config.Config, p Paths, token string) []string {
	env := process.InheritSafe(
		// HOME and XDG_* are rebuilt below to point inside the run
		// directory, so ~/.config/amiro/config.yaml is the test's file and
		// not the developer's.
		"HOME", "XDG_DATA_HOME", "XDG_CONFIG_HOME", "XDG_CACHE_HOME",
		// go-keyring reaches the OS keychain over the session bus. Removing
		// it makes internal/secrets.KeyringStore fall back to its
		// documented keys.json file inside the per-test app-data directory,
		// which is exactly the isolation the suite needs. See
		// docs/testing/06-fixtures-and-seeding.md.
		"DBUS_SESSION_BUS_ADDRESS", "XDG_RUNTIME_DIR",
	)

	set := map[string]string{
		"AMIRO_AUTH_TOKEN":      token,
		"AMIRO_APP_DATA_DIR":    p.AppDataDir,
		"AMIRO_BIND_HOST":       cfg.Backend.BindHost,
		"AMIRO_PORT":            fmt.Sprint(cfg.Backend.Port),
		"AMIRO_DATABASE_DRIVER": cfg.Backend.Database.Driver,
		"AMIRO_DATABASE_URL":    p.DatabaseDSN,
		"AMIRO_WORKSPACE_ROOT":  p.WorkspaceRoot,

		"HOME":            p.Home,
		"XDG_DATA_HOME":   p.Home + "/.local/share",
		"XDG_CONFIG_HOME": p.Home + "/.config",
		"XDG_CACHE_HOME":  p.Home + "/.cache",
	}
	if runtime.GOOS == "windows" {
		set["USERPROFILE"] = p.Home
		set["APPDATA"] = p.Home
	}
	// A postgres deployment additionally requires a bucket; internal/config
	// refuses to start without one.
	if cfg.Backend.Database.Driver == "postgres" {
		set["AMIRO_S3_BUCKET"] = "amiro-tests"
	}

	// backend.env is applied last so a test config can override anything
	// above -- including the defaults this function just chose.
	for k, v := range cfg.Backend.Env {
		set[k] = v
	}

	keys := make([]string, 0, len(set))
	for k := range set {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	for _, k := range keys {
		if set[k] == "" {
			// An empty AMIRO_* variable is not the same as an unset one:
			// internal/config's getEnv treats "" as unset and falls through
			// to the legacy BETTERCHATBOT_ name, so passing it changes
			// nothing but makes the environment harder to read.
			continue
		}
		env = append(env, k+"="+set[k])
	}
	return env
}

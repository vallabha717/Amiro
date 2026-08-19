package backend

import (
	"os"
	"path/filepath"
	"strings"
	"testing"

	"amiro/tests/harness/config"
)

func envMap(t *testing.T, kvs []string) map[string]string {
	t.Helper()
	out := map[string]string{}
	for _, kv := range kvs {
		k, v, ok := strings.Cut(kv, "=")
		if ok {
			out[k] = v
		}
	}
	return out
}

// TestEnv_TranslatesResolvedConfigIntoTheApplicationsOwnNames pins the one
// translation table in the test system. Everything else speaks in resolved
// config; only this function knows AMIRO_*.
func TestEnv_TranslatesResolvedConfigIntoTheApplicationsOwnNames(t *testing.T) {
	cfg := config.Defaults()
	cfg.Backend.BindHost = "127.0.0.1"
	paths := Paths{
		AppDataDir:    "/run/appdata",
		WorkspaceRoot: "/run/workspace",
		Home:          "/run/home",
		DatabaseDSN:   "/run/db/amiro.db",
	}
	env := envMap(t, Env(&cfg, paths, "test-token"))

	for k, want := range map[string]string{
		"AMIRO_AUTH_TOKEN":      "test-token",
		"AMIRO_APP_DATA_DIR":    "/run/appdata",
		"AMIRO_BIND_HOST":       "127.0.0.1",
		"AMIRO_DATABASE_DRIVER": "sqlite",
		"AMIRO_DATABASE_URL":    "/run/db/amiro.db",
		"AMIRO_WORKSPACE_ROOT":  "/run/workspace",
		"HOME":                  "/run/home",
		"XDG_CONFIG_HOME":       "/run/home/.config",
	} {
		if env[k] != want {
			t.Errorf("%s = %q, want %q", k, env[k], want)
		}
	}
}

// TestEnv_NeverLeaksTheDevelopersOwnApplicationEnvironment is the guard for
// the worst failure this package can enable.
//
// A spawned backend inheriting AMIRO_APP_DATA_DIR writes into the
// developer's real database. It happened once during Phase 0 and was caught
// only because /api/auth/status answered isFirstUser:false against what was
// supposed to be an empty database.
func TestEnv_NeverLeaksTheDevelopersOwnApplicationEnvironment(t *testing.T) {
	t.Setenv("AMIRO_APP_DATA_DIR", "/home/someone/.local/share/amiro")
	t.Setenv("AMIRO_DATABASE_URL", "/home/someone/real.db")
	t.Setenv("BETTERCHATBOT_AUTH_TOKEN", "their-token")

	cfg := config.Defaults()
	env := envMap(t, Env(&cfg, Paths{AppDataDir: "/run/appdata", Home: "/run/home", DatabaseDSN: "/run/db.db"}, "tok"))

	if env["AMIRO_APP_DATA_DIR"] != "/run/appdata" {
		t.Errorf("AMIRO_APP_DATA_DIR = %q; the developer's value leaked through", env["AMIRO_APP_DATA_DIR"])
	}
	if _, present := env["BETTERCHATBOT_AUTH_TOKEN"]; present {
		t.Error("a legacy BETTERCHATBOT_* variable survived; internal/config would read it as a fallback")
	}
}

// TestEnv_BreaksTheKeyringChannelSoProviderKeysStayInTheRunDirectory.
//
// internal/secrets.KeyringStore writes to the OS keychain first and falls
// back to <appDataDir>/keys.json. Removing the session bus address makes the
// keyring call fail, so the fallback -- inside the per-test app-data
// directory -- is what gets used. A suite that writes into a developer's
// real login keychain is not acceptable.
func TestEnv_BreaksTheKeyringChannelSoProviderKeysStayInTheRunDirectory(t *testing.T) {
	t.Setenv("DBUS_SESSION_BUS_ADDRESS", "unix:path=/run/user/1000/bus")
	t.Setenv("XDG_RUNTIME_DIR", "/run/user/1000")

	cfg := config.Defaults()
	env := envMap(t, Env(&cfg, Paths{AppDataDir: "/run/appdata", Home: "/run/home"}, "tok"))

	for _, k := range []string{"DBUS_SESSION_BUS_ADDRESS", "XDG_RUNTIME_DIR"} {
		if _, present := env[k]; present {
			t.Errorf("%s survived; the spawned backend can reach the real keyring", k)
		}
	}
}

func TestEnv_BackendEnvOverridesEverythingElse(t *testing.T) {
	cfg := config.Defaults()
	cfg.Backend.Env = map[string]string{"AMIRO_BIND_HOST": "0.0.0.0", "CUSTOM_THING": "yes"}
	env := envMap(t, Env(&cfg, Paths{AppDataDir: "/a", Home: "/h"}, "tok"))

	if env["AMIRO_BIND_HOST"] != "0.0.0.0" {
		t.Errorf("backend.env did not override the default bind host: %q", env["AMIRO_BIND_HOST"])
	}
	if env["CUSTOM_THING"] != "yes" {
		t.Error("backend.env passthrough was dropped")
	}
}

func TestEnv_OmitsEmptyValuesRatherThanPassingThemBlank(t *testing.T) {
	// internal/config's getEnv treats "" as unset and falls through to the
	// legacy name, so a blank AMIRO_* variable changes nothing and only
	// makes the environment harder to read.
	cfg := config.Defaults()
	env := envMap(t, Env(&cfg, Paths{AppDataDir: "/a", Home: "/h"}, "tok"))
	if v, present := env["AMIRO_WORKSPACE_ROOT"]; present && v == "" {
		t.Error("an empty AMIRO_WORKSPACE_ROOT was passed rather than omitted")
	}
}

func TestNewDatabase_GivesEachTestItsOwnSQLiteFile(t *testing.T) {
	cfg := config.Defaults()
	dirA, dirB := t.TempDir(), t.TempDir()

	a, err := NewDatabase(t.Context(), &cfg, dirA, "backend-chat-TestA")
	if err != nil {
		t.Fatal(err)
	}
	b, err := NewDatabase(t.Context(), &cfg, dirB, "backend-chat-TestB")
	if err != nil {
		t.Fatal(err)
	}
	if a.DSN == b.DSN {
		t.Fatalf("two tests share a database: %s", a.DSN)
	}
	for _, d := range []*Database{a, b} {
		if !strings.HasSuffix(d.DSN, filepath.Join("db", "amiro.db")) {
			t.Errorf("unexpected sqlite path %q", d.DSN)
		}
		if _, err := os.Stat(filepath.Dir(d.DSN)); err != nil {
			t.Errorf("the database directory was not created: %v", err)
		}
	}

	if err := a.Drop(); err != nil {
		t.Errorf("Drop: %v", err)
	}
	if _, err := os.Stat(a.Dir); err == nil {
		t.Error("Drop left the database directory behind")
	}
	// Drop is idempotent: teardown may run it twice.
	if err := a.Drop(); err != nil {
		t.Errorf("second Drop: %v", err)
	}
}

func TestNewDatabase_KeepOnSuccessPreservesTheFile(t *testing.T) {
	cfg := config.Defaults()
	cfg.Backend.Database.KeepOnSuccess = true
	dir := t.TempDir()
	d, err := NewDatabase(t.Context(), &cfg, dir, "x")
	if err != nil {
		t.Fatal(err)
	}
	if err := d.Drop(); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(d.Dir); err != nil {
		t.Error("keepOnSuccess did not preserve the database directory")
	}
}

func TestSchemaName_StaysWithinPostgresIdentifierLimits(t *testing.T) {
	long := strings.Repeat("backend-chat-TestSomethingWithAVeryLongName", 3)
	got := schemaName(long)
	// Postgres truncates at 63 bytes, so two long names sharing a prefix
	// would collide -- the exact failure per-test isolation exists to
	// prevent.
	if len(got) > 63 {
		t.Errorf("schema name is %d bytes: %q", len(got), got)
	}
	other := schemaName(long + "-different")
	if got == other {
		t.Error("two long test names produced the same schema")
	}
	for _, r := range got {
		if !(r >= 'a' && r <= 'z' || r >= '0' && r <= '9' || r == '_') {
			t.Errorf("schema name %q contains %q, which needs quoting", got, r)
		}
	}
}

func TestWithSearchPath_HandlesBothDSNForms(t *testing.T) {
	url, err := withSearchPath("postgres://user:pw@localhost:5432/amiro?sslmode=disable", "amiro_test_x")
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(url, "search_path=amiro_test_x") {
		t.Errorf("URL form lost the search path: %s", url)
	}
	if !strings.Contains(url, "sslmode=disable") {
		t.Errorf("URL form dropped an existing parameter: %s", url)
	}

	kv, err := withSearchPath("host=localhost dbname=amiro", "amiro_test_x")
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(kv, "search_path=amiro_test_x") {
		t.Errorf("keyword form lost the search path: %s", kv)
	}
}

func TestCopyWorkspace_CopiesRatherThanSharing(t *testing.T) {
	src := t.TempDir()
	if err := os.MkdirAll(filepath.Join(src, "nested"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(src, "nested", "file.txt"), []byte("original"), 0o644); err != nil {
		t.Fatal(err)
	}

	dst := filepath.Join(t.TempDir(), "workspace")
	if err := CopyWorkspace(src, dst); err != nil {
		t.Fatalf("CopyWorkspace: %v", err)
	}
	copied := filepath.Join(dst, "nested", "file.txt")
	if data, err := os.ReadFile(copied); err != nil || string(data) != "original" {
		t.Fatalf("the file was not copied: %v %q", err, data)
	}

	// Mutating the copy must not touch the fixture. A test that poisons a
	// fixture breaks every test after it, in a different order every run.
	if err := os.WriteFile(copied, []byte("the agent wrote this"), 0o644); err != nil {
		t.Fatal(err)
	}
	original, err := os.ReadFile(filepath.Join(src, "nested", "file.txt"))
	if err != nil {
		t.Fatal(err)
	}
	if string(original) != "original" {
		t.Error("writing to the copy modified the fixture")
	}
}

func TestCopyWorkspace_PreservesSymlinksAsSymlinks(t *testing.T) {
	src := t.TempDir()
	if err := os.WriteFile(filepath.Join(src, "target.txt"), []byte("x"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink("target.txt", filepath.Join(src, "link.txt")); err != nil {
		t.Skipf("symlinks unavailable: %v", err)
	}
	dst := filepath.Join(t.TempDir(), "ws")
	if err := CopyWorkspace(src, dst); err != nil {
		t.Fatal(err)
	}
	// fixtures/workspaces/unicode contains symlinks deliberately, to
	// exercise path escaping in the file tools. Following them here would
	// silently defeat that.
	info, err := os.Lstat(filepath.Join(dst, "link.txt"))
	if err != nil {
		t.Fatal(err)
	}
	if info.Mode()&os.ModeSymlink == 0 {
		t.Error("the symlink was dereferenced during the copy")
	}
}

func TestSanitizeTestID_HandlesSubtestSlashes(t *testing.T) {
	if got := SanitizeTestID("TestApproval/allows once"); got != "TestApproval-allows_once" {
		t.Errorf("SanitizeTestID = %q", got)
	}
}

func TestFindRepoRoot_LocatesTheDirectoryHoldingBackendGo(t *testing.T) {
	root, err := FindRepoRoot(".")
	if err != nil {
		t.Fatalf("FindRepoRoot: %v", err)
	}
	if _, err := os.Stat(filepath.Join(root, "backend-go", "go.mod")); err != nil {
		t.Errorf("found %s, which has no backend-go/go.mod", root)
	}
}

func TestBuild_ReusesTheCachedBinaryOnASecondCall(t *testing.T) {
	root, err := FindRepoRoot(".")
	if err != nil {
		t.Fatal(err)
	}
	spec := BuildSpec{RepoRoot: root, Package: "./cmd/server", Name: "server"}

	first, err := Build(t.Context(), nil, spec)
	if err != nil {
		t.Fatalf("Build: %v", err)
	}
	second, err := Build(t.Context(), nil, spec)
	if err != nil {
		t.Fatalf("second Build: %v", err)
	}
	if first != second {
		t.Errorf("the cache key is not stable: %s then %s", first, second)
	}
	if _, err := os.Stat(first); err != nil {
		t.Errorf("the built binary is not where Build said: %v", err)
	}
	// The key must be content-derived, not mtime-derived: a `git checkout`
	// rewrites mtimes without changing a byte, and rebuilding the world
	// after every branch switch is what this cache exists to avoid.
	if !strings.Contains(filepath.Base(first), "server-") {
		t.Errorf("unexpected cache file name %q", filepath.Base(first))
	}
}

func TestBuild_HonoursAConfiguredBinaryWithoutBuilding(t *testing.T) {
	fake := filepath.Join(t.TempDir(), "prebuilt-server")
	if err := os.WriteFile(fake, []byte("#!/bin/sh\n"), 0o755); err != nil {
		t.Fatal(err)
	}
	got, err := Build(t.Context(), nil, BuildSpec{Override: fake})
	if err != nil {
		t.Fatalf("Build: %v", err)
	}
	if got != fake {
		t.Errorf("Build returned %q, want the configured %q", got, fake)
	}
}

func TestBuild_ReportsAMissingConfiguredBinaryClearly(t *testing.T) {
	_, err := Build(t.Context(), nil, BuildSpec{Override: "/definitely/not/here"})
	if err == nil {
		t.Fatal("expected an error")
	}
	if !strings.Contains(err.Error(), "/definitely/not/here") {
		t.Errorf("the error does not name the path: %v", err)
	}
}

func TestBuild_EmbedUI_InvalidatesCacheWhenWebDistChanges(t *testing.T) {
	root, err := FindRepoRoot(".")
	if err != nil {
		t.Fatal(err)
	}
	moduleDir := filepath.Join(root, "backend-go")
	distDir := filepath.Join(moduleDir, "internal", "web", "dist")
	if err := os.MkdirAll(distDir, 0o755); err != nil {
		t.Fatal(err)
	}

	spec := BuildSpec{
		RepoRoot: root,
		Package:  "./cmd/server",
		Name:     "server",
		Tags:     []string{"embedui"},
	}

	hashBefore, err := hashTree(moduleDir, spec.Tags)
	if err != nil {
		t.Fatalf("hashTree before: %v", err)
	}

	markerFile := filepath.Join(distDir, ".test-marker-probe")
	if err := os.WriteFile(markerFile, []byte("probe-content-1"), 0o644); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		_ = os.Remove(markerFile)
	})

	hashAfterMarker, err := hashTree(moduleDir, spec.Tags)
	if err != nil {
		t.Fatalf("hashTree after marker: %v", err)
	}
	if hashBefore == hashAfterMarker {
		t.Errorf("adding a file under internal/web/dist did not change hashTree with embedui tag (hash: %s)", hashBefore)
	}

	if err := os.WriteFile(markerFile, []byte("probe-content-modified-2"), 0o644); err != nil {
		t.Fatal(err)
	}
	hashAfterModify, err := hashTree(moduleDir, spec.Tags)
	if err != nil {
		t.Fatalf("hashTree after modify: %v", err)
	}
	if hashAfterMarker == hashAfterModify {
		t.Errorf("modifying a file under internal/web/dist did not change hashTree with embedui tag (hash: %s)", hashAfterMarker)
	}

	// For a spec WITHOUT embedui tag, changes to dist must NOT change the hash
	specNoEmbed := BuildSpec{
		RepoRoot: root,
		Package:  "./cmd/server",
		Name:     "server",
		Tags:     nil,
	}
	noEmbedHash1, err := hashTree(moduleDir, specNoEmbed.Tags)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(markerFile, []byte("probe-content-3"), 0o644); err != nil {
		t.Fatal(err)
	}
	noEmbedHash2, err := hashTree(moduleDir, specNoEmbed.Tags)
	if err != nil {
		t.Fatal(err)
	}
	if noEmbedHash1 != noEmbedHash2 {
		t.Errorf("changes under internal/web/dist changed hashTree without embedui tag (%s != %s)", noEmbedHash1, noEmbedHash2)
	}
}


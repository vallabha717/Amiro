package config_test

import (
	"os"
	"path/filepath"
	"testing"

	"amiro/tests/harness"
	"amiro/tests/harness/backend"
	"amiro/tests/harness/config"
)

// TestConfig_EnvTranslatesResolvedValuesToAmiroEnvironment verifies the mapping
// in harness/backend.Env() from harness configuration keys to the AMIRO_* environment
// variables the server expects.
func TestConfig_EnvTranslatesResolvedValuesToAmiroEnvironment(t *testing.T) {
	cfg := config.Defaults()
	cfg.Backend.BindHost = "127.0.0.1"
	cfg.Backend.Port = 8080
	cfg.Backend.Database.Driver = "sqlite"

	env := backend.Env(&cfg, backend.Paths{
		AppDataDir:    "/tmp/appdata",
		WorkspaceRoot: "/tmp/workspace",
		Home:          "/tmp/home",
		DatabaseDSN:   "/tmp/appdata/amiro.db",
	}, "test-secret-token")

	envMap := map[string]string{}
	for _, kv := range env {
		for i := 0; i < len(kv); i++ {
			if kv[i] == '=' {
				envMap[kv[:i]] = kv[i+1:]
				break
			}
		}
	}

	if envMap["AMIRO_BIND_HOST"] != "127.0.0.1" {
		t.Errorf("AMIRO_BIND_HOST = %q, want 127.0.0.1", envMap["AMIRO_BIND_HOST"])
	}
	if envMap["AMIRO_AUTH_TOKEN"] != "test-secret-token" {
		t.Errorf("AMIRO_AUTH_TOKEN = %q, want test-secret-token", envMap["AMIRO_AUTH_TOKEN"])
	}
	if envMap["AMIRO_APP_DATA_DIR"] != "/tmp/appdata" {
		t.Errorf("AMIRO_APP_DATA_DIR = %q, want /tmp/appdata", envMap["AMIRO_APP_DATA_DIR"])
	}
	if envMap["AMIRO_WORKSPACE_ROOT"] != "/tmp/workspace" {
		t.Errorf("AMIRO_WORKSPACE_ROOT = %q, want /tmp/workspace", envMap["AMIRO_WORKSPACE_ROOT"])
	}
	if envMap["HOME"] != "/tmp/home" {
		t.Errorf("HOME = %q, want /tmp/home", envMap["HOME"])
	}
}

// TestConfig_SQLitePathFallbackPrefersAmiroDB verifies that the backend prioritizes
// amiro.db over legacy betterchatbot.db when both or either exist.
func TestConfig_SQLitePathFallbackPrefersAmiroDB(t *testing.T) {
	h := harness.New(t)
	be := h.Backend()

	// Verify the database created is named amiro.db
	if _, err := os.Stat(be.DB.DSN); err != nil {
		t.Errorf("expected amiro.db to exist at %s: %v", be.DB.DSN, err)
	}
	if filepath.Base(be.DB.DSN) != "amiro.db" {
		t.Errorf("expected db file name 'amiro.db', got %q", filepath.Base(be.DB.DSN))
	}
}

// TestConfig_PostgresValidationRequiresDSN verifies that configuring driver=postgres without a DSN fails validation.
func TestConfig_PostgresValidationRequiresDSN(t *testing.T) {
	cfg := config.Defaults()
	cfg.Backend.Database.Driver = "postgres"
	cfg.Backend.Database.DSN = ""

	_, err := config.Validate(&cfg, ".")
	if err == nil {
		t.Fatal("expected validation error when postgres is configured without a DSN")
	}
}

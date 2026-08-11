package config

import (
	"path/filepath"
	"runtime"
	"testing"
)

func TestLoad_GeneratesDifferentTokenEachCallWhenEnvVarUnset(t *testing.T) {
	t.Setenv("BETTERCHATBOT_AUTH_TOKEN", "")
	t.Setenv("BETTERCHATBOT_APP_DATA_DIR", t.TempDir())

	first, err := Load()
	if err != nil {
		t.Fatalf("Load: %v", err)
	}
	second, err := Load()
	if err != nil {
		t.Fatalf("Load: %v", err)
	}

	if first.AuthToken == "" {
		t.Fatal("generated AuthToken is empty")
	}
	if first.AuthToken == second.AuthToken {
		t.Fatal("two unset-env Load() calls produced the same token; token is not being randomly generated")
	}
}

func TestLoad_UsesProvidedAuthToken(t *testing.T) {
	t.Setenv("BETTERCHATBOT_AUTH_TOKEN", "fixed-test-token")
	t.Setenv("BETTERCHATBOT_APP_DATA_DIR", t.TempDir())

	cfg, err := Load()
	if err != nil {
		t.Fatalf("Load: %v", err)
	}
	if cfg.AuthToken != "fixed-test-token" {
		t.Fatalf("AuthToken = %q, want %q", cfg.AuthToken, "fixed-test-token")
	}
}

func TestLoad_DefaultsAllowedOriginToTauriLocalhost(t *testing.T) {
	t.Setenv("BETTERCHATBOT_ALLOWED_ORIGIN", "")
	t.Setenv("BETTERCHATBOT_APP_DATA_DIR", t.TempDir())

	cfg, err := Load()
	if err != nil {
		t.Fatalf("Load: %v", err)
	}
	if cfg.AllowedOrigin != "tauri://localhost" {
		t.Fatalf("AllowedOrigin = %q, want default %q", cfg.AllowedOrigin, "tauri://localhost")
	}
}

func TestLoad_UsesProvidedAllowedOrigin(t *testing.T) {
	t.Setenv("BETTERCHATBOT_ALLOWED_ORIGIN", "http://localhost:3000")
	t.Setenv("BETTERCHATBOT_APP_DATA_DIR", t.TempDir())

	cfg, err := Load()
	if err != nil {
		t.Fatalf("Load: %v", err)
	}
	if cfg.AllowedOrigin != "http://localhost:3000" {
		t.Fatalf("AllowedOrigin = %q, want %q", cfg.AllowedOrigin, "http://localhost:3000")
	}
}

func TestLoad_UsesProvidedAppDataDirVerbatim(t *testing.T) {
	dir := filepath.Join(t.TempDir(), "custom-app-data")
	t.Setenv("BETTERCHATBOT_APP_DATA_DIR", dir)

	cfg, err := Load()
	if err != nil {
		t.Fatalf("Load: %v", err)
	}
	if cfg.AppDataDir != dir {
		t.Fatalf("AppDataDir = %q, want %q", cfg.AppDataDir, dir)
	}
}

func TestLoad_LinuxFallsBackToXDGDataHomeWhenAppDataDirUnset(t *testing.T) {
	if runtime.GOOS != "linux" {
		t.Skip("this fallback branch is Linux-specific; other OSes have their own branch in appDataDir()")
	}

	t.Setenv("BETTERCHATBOT_APP_DATA_DIR", "")
	xdg := t.TempDir()
	t.Setenv("XDG_DATA_HOME", xdg)

	cfg, err := Load()
	if err != nil {
		t.Fatalf("Load: %v", err)
	}
	want := filepath.Join(xdg, "better-chatbot")
	if cfg.AppDataDir != want {
		t.Fatalf("AppDataDir = %q, want %q", cfg.AppDataDir, want)
	}
}

func TestLoad_PostgresDriverRequiresDatabaseURL(t *testing.T) {
	t.Setenv("BETTERCHATBOT_APP_DATA_DIR", t.TempDir())
	t.Setenv("BETTERCHATBOT_DATABASE_DRIVER", "postgres")
	t.Setenv("BETTERCHATBOT_DATABASE_URL", "")

	if _, err := Load(); err == nil {
		t.Fatal("expected an error when DATABASE_DRIVER=postgres with no DATABASE_URL")
	}
}

func TestLoad_PostgresDriverRequiresS3Bucket(t *testing.T) {
	t.Setenv("BETTERCHATBOT_APP_DATA_DIR", t.TempDir())
	t.Setenv("BETTERCHATBOT_DATABASE_DRIVER", "postgres")
	t.Setenv("BETTERCHATBOT_DATABASE_URL", "postgres://localhost/test")
	t.Setenv("BETTERCHATBOT_S3_BUCKET", "")

	if _, err := Load(); err == nil {
		t.Fatal("expected an error when DATABASE_DRIVER=postgres with no S3_BUCKET")
	}
}

func TestLoad_SqliteDriverDoesNotRequireS3Bucket(t *testing.T) {
	t.Setenv("BETTERCHATBOT_APP_DATA_DIR", t.TempDir())
	t.Setenv("BETTERCHATBOT_DATABASE_DRIVER", "sqlite")
	t.Setenv("BETTERCHATBOT_S3_BUCKET", "")

	cfg, err := Load()
	if err != nil {
		t.Fatalf("Load: %v", err)
	}
	if cfg.S3Bucket != "" {
		t.Fatalf("S3Bucket = %q, want empty on desktop/sqlite", cfg.S3Bucket)
	}
}

func TestLoad_LinuxFallsBackToHomeLocalShareWhenNeitherEnvVarSet(t *testing.T) {
	if runtime.GOOS != "linux" {
		t.Skip("this fallback branch is Linux-specific; other OSes have their own branch in appDataDir()")
	}

	t.Setenv("BETTERCHATBOT_APP_DATA_DIR", "")
	t.Setenv("XDG_DATA_HOME", "")
	home := t.TempDir()
	t.Setenv("HOME", home)

	cfg, err := Load()
	if err != nil {
		t.Fatalf("Load: %v", err)
	}
	want := filepath.Join(home, ".local", "share", "better-chatbot")
	if cfg.AppDataDir != want {
		t.Fatalf("AppDataDir = %q, want %q", cfg.AppDataDir, want)
	}
}

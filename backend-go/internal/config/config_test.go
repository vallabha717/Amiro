package config

import (
	"path/filepath"
	"runtime"
	"testing"
)

func TestLoad_GeneratesDifferentTokenEachCallWhenEnvVarUnset(t *testing.T) {
	t.Setenv("AMIRO_AUTH_TOKEN", "")
	t.Setenv("BETTERCHATBOT_AUTH_TOKEN", "")
	t.Setenv("AMIRO_APP_DATA_DIR", t.TempDir())

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

func TestLoad_UsesAmiroAuthToken(t *testing.T) {
	t.Setenv("AMIRO_AUTH_TOKEN", "amiro-token-123")
	t.Setenv("BETTERCHATBOT_AUTH_TOKEN", "legacy-token")
	t.Setenv("AMIRO_APP_DATA_DIR", t.TempDir())

	cfg, err := Load()
	if err != nil {
		t.Fatalf("Load: %v", err)
	}
	if cfg.AuthToken != "amiro-token-123" {
		t.Fatalf("AuthToken = %q, want %q", cfg.AuthToken, "amiro-token-123")
	}
}

func TestLoad_FallsBackToLegacyAuthToken(t *testing.T) {
	t.Setenv("AMIRO_AUTH_TOKEN", "")
	t.Setenv("BETTERCHATBOT_AUTH_TOKEN", "legacy-token-456")
	t.Setenv("AMIRO_APP_DATA_DIR", t.TempDir())

	cfg, err := Load()
	if err != nil {
		t.Fatalf("Load: %v", err)
	}
	if cfg.AuthToken != "legacy-token-456" {
		t.Fatalf("AuthToken = %q, want %q", cfg.AuthToken, "legacy-token-456")
	}
}

func TestLoad_DefaultsAllowedOriginToTauriLocalhost(t *testing.T) {
	t.Setenv("AMIRO_ALLOWED_ORIGIN", "")
	t.Setenv("BETTERCHATBOT_ALLOWED_ORIGIN", "")
	t.Setenv("AMIRO_APP_DATA_DIR", t.TempDir())

	cfg, err := Load()
	if err != nil {
		t.Fatalf("Load: %v", err)
	}
	if cfg.AllowedOrigin != "tauri://localhost" {
		t.Fatalf("AllowedOrigin = %q, want default %q", cfg.AllowedOrigin, "tauri://localhost")
	}
}

func TestLoad_UsesProvidedAllowedOrigin(t *testing.T) {
	t.Setenv("AMIRO_ALLOWED_ORIGIN", "http://localhost:3000")
	t.Setenv("AMIRO_APP_DATA_DIR", t.TempDir())

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
	t.Setenv("AMIRO_APP_DATA_DIR", dir)

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

	t.Setenv("AMIRO_APP_DATA_DIR", "")
	t.Setenv("BETTERCHATBOT_APP_DATA_DIR", "")
	xdg := t.TempDir()
	t.Setenv("XDG_DATA_HOME", xdg)

	cfg, err := Load()
	if err != nil {
		t.Fatalf("Load: %v", err)
	}
	want := filepath.Join(xdg, "amiro")
	if cfg.AppDataDir != want {
		t.Fatalf("AppDataDir = %q, want %q", cfg.AppDataDir, want)
	}
}

func TestLoad_PostgresDriverRequiresDatabaseURL(t *testing.T) {
	t.Setenv("AMIRO_APP_DATA_DIR", t.TempDir())
	t.Setenv("AMIRO_DATABASE_DRIVER", "postgres")
	t.Setenv("AMIRO_DATABASE_URL", "")
	t.Setenv("BETTERCHATBOT_DATABASE_URL", "")

	if _, err := Load(); err == nil {
		t.Fatal("expected an error when DATABASE_DRIVER=postgres with no DATABASE_URL")
	}
}

func TestLoad_PostgresDriverRequiresS3Bucket(t *testing.T) {
	t.Setenv("AMIRO_APP_DATA_DIR", t.TempDir())
	t.Setenv("AMIRO_DATABASE_DRIVER", "postgres")
	t.Setenv("AMIRO_DATABASE_URL", "postgres://localhost/test")
	t.Setenv("AMIRO_S3_BUCKET", "")
	t.Setenv("BETTERCHATBOT_S3_BUCKET", "")

	if _, err := Load(); err == nil {
		t.Fatal("expected an error when DATABASE_DRIVER=postgres with no S3_BUCKET")
	}
}

func TestLoad_SqliteDriverDoesNotRequireS3Bucket(t *testing.T) {
	t.Setenv("AMIRO_APP_DATA_DIR", t.TempDir())
	t.Setenv("AMIRO_DATABASE_DRIVER", "sqlite")
	t.Setenv("AMIRO_S3_BUCKET", "")
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

	t.Setenv("AMIRO_APP_DATA_DIR", "")
	t.Setenv("BETTERCHATBOT_APP_DATA_DIR", "")
	t.Setenv("XDG_DATA_HOME", "")
	home := t.TempDir()
	t.Setenv("HOME", home)

	cfg, err := Load()
	if err != nil {
		t.Fatalf("Load: %v", err)
	}
	want := filepath.Join(home, ".local", "share", "amiro")
	if cfg.AppDataDir != want {
		t.Fatalf("AppDataDir = %q, want %q", cfg.AppDataDir, want)
	}
}

func TestLoad_ParsesSandboxNetworkAllowFromCommaSeparatedEnv(t *testing.T) {
	t.Setenv("AMIRO_APP_DATA_DIR", t.TempDir())
	t.Setenv("AMIRO_SANDBOX_NETWORK_ALLOW", "go build, npm install ,  npm ci")

	cfg, err := Load()
	if err != nil {
		t.Fatalf("Load: %v", err)
	}
	want := []string{"go build", "npm install", "npm ci"}
	if len(cfg.SandboxNetworkAllow) != len(want) {
		t.Fatalf("SandboxNetworkAllow = %v, want %v", cfg.SandboxNetworkAllow, want)
	}
	for i, w := range want {
		if cfg.SandboxNetworkAllow[i] != w {
			t.Errorf("SandboxNetworkAllow[%d] = %q, want %q", i, cfg.SandboxNetworkAllow[i], w)
		}
	}
}

func TestLoad_SandboxNetworkAllowDefaultsToNilNotEmptySlice(t *testing.T) {
	t.Setenv("AMIRO_APP_DATA_DIR", t.TempDir())
	t.Setenv("AMIRO_SANDBOX_NETWORK_ALLOW", "")
	t.Setenv("BETTERCHATBOT_SANDBOX_NETWORK_ALLOW", "")

	cfg, err := Load()
	if err != nil {
		t.Fatalf("Load: %v", err)
	}
	if cfg.SandboxNetworkAllow != nil {
		t.Fatalf("SandboxNetworkAllow = %v, want nil when unset -- the safe default is to deny every command's network, not allow-list an empty string", cfg.SandboxNetworkAllow)
	}
}

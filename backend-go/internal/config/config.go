// Package config resolves sidecar startup configuration: the app-data
// directory, the shared-secret auth token, and the allowed webview origin.
package config

import (
	"crypto/rand"
	"encoding/hex"
	"fmt"
	"os"
	"path/filepath"
	"runtime"
	"strconv"
	"strings"
)

type Config struct {
	// AuthToken is the shared secret the webview must send on every request.
	// Passed in from Rust via AMIRO_AUTH_TOKEN (or legacy BETTERCHATBOT_AUTH_TOKEN);
	// generated here as a fallback for standalone (non-sidecar) runs, e.g. local dev.
	AuthToken string
	// AllowedOrigin is the exact webview origin CORS allows. Passed in from
	// Rust via AMIRO_ALLOWED_ORIGIN (or BETTERCHATBOT_ALLOWED_ORIGIN); defaults to the Tauri dev origin.
	AllowedOrigin string
	// AppDataDir is the OS-specific app-data root for SQLite/local storage.
	AppDataDir string
	// BindHost is the interface the listener binds. Defaults to 127.0.0.1 --
	// must never be 0.0.0.0 in the real sidecar. Override via AMIRO_BIND_HOST
	// or legacy BETTERCHATBOT_BIND_HOST.
	BindHost string
	// Port is the TCP port the listener binds. Defaults to 0 (OS-assigned),
	// which is what the real sidecar relies on -- Rust reads the actual port
	// off stdout. Override via AMIRO_PORT or BETTERCHATBOT_PORT.
	Port int
	// DatabaseDriver selects the GORM dialect: "sqlite" (desktop default)
	// or "postgres" (web deploy). Override via AMIRO_DATABASE_DRIVER or BETTERCHATBOT_DATABASE_DRIVER.
	DatabaseDriver string
	// DatabaseDSN is the dialect-appropriate connection string: a file path
	// under AppDataDir for sqlite, a "postgres://..." URL for postgres.
	// Override via AMIRO_DATABASE_URL or BETTERCHATBOT_DATABASE_URL.
	DatabaseDSN string
	// S3Bucket names the bucket internal/storage.S3Storage writes to.
	// Required when DatabaseDriver is "postgres". Override via AMIRO_S3_BUCKET or BETTERCHATBOT_S3_BUCKET.
	S3Bucket string
	// WorkspaceRoot is the single directory tree the agent's file tools may
	// read and write. Set via AMIRO_WORKSPACE_ROOT or BETTERCHATBOT_WORKSPACE_ROOT.
	WorkspaceRoot string
	// SandboxNetworkAllow is a per-project, deliberate opt-in: shell
	// commands whose prefix matches an entry here reach the network even
	// under a real sandbox backend, which otherwise denies it by default
	// (docs/coding-agent-parity/03-sandboxed-execution.md). Matched the
	// same way internal/agent/permission/command.go's shell allowlist
	// matches -- see internal/agent/sandbox.NetworkAllowed. Set via
	// AMIRO_SANDBOX_NETWORK_ALLOW as a comma-separated list, e.g.
	// "go build,npm install,npm ci". Empty (the default) denies network to
	// every sandboxed command -- the safe direction; a user who needs an
	// exception adds it deliberately rather than the feature guessing one.
	SandboxNetworkAllow []string
	// GitHubAPIBase overrides create_pr's GitHub REST API root. Empty (the
	// default) means the real "https://api.github.com". This exists for
	// tests -- docs/coding-agent-parity/phases/phase-03-git-remote-operations.md's
	// suite points it at a fake local server rather than reaching the real
	// GitHub API -- not as a user-facing setting; GitHub Enterprise Server
	// support is a real gap this does not attempt to close. Set via
	// AMIRO_GITHUB_API_BASE (or legacy BETTERCHATBOT_GITHUB_API_BASE).
	GitHubAPIBase string
}

func getEnv(amiroKey, legacyKey string) string {
	if val := os.Getenv(amiroKey); val != "" {
		return val
	}
	return os.Getenv(legacyKey)
}

func Load() (Config, error) {
	token := getEnv("AMIRO_AUTH_TOKEN", "BETTERCHATBOT_AUTH_TOKEN")
	if token == "" {
		generated, err := randomToken(32)
		if err != nil {
			return Config{}, err
		}
		token = generated
	}

	origin := getEnv("AMIRO_ALLOWED_ORIGIN", "BETTERCHATBOT_ALLOWED_ORIGIN")
	if origin == "" {
		origin = "tauri://localhost"
	}

	bindHost := getEnv("AMIRO_BIND_HOST", "BETTERCHATBOT_BIND_HOST")
	if bindHost == "" {
		bindHost = "127.0.0.1"
	}

	port := 0
	if raw := getEnv("AMIRO_PORT", "BETTERCHATBOT_PORT"); raw != "" {
		parsed, err := strconv.Atoi(raw)
		if err != nil {
			return Config{}, fmt.Errorf("AMIRO_PORT: %w", err)
		}
		port = parsed
	}

	dataDir, err := appDataDir()
	if err != nil {
		return Config{}, err
	}

	dbDriver := getEnv("AMIRO_DATABASE_DRIVER", "BETTERCHATBOT_DATABASE_DRIVER")
	if dbDriver == "" {
		dbDriver = "sqlite"
	}

	dbDSN := getEnv("AMIRO_DATABASE_URL", "BETTERCHATBOT_DATABASE_URL")
	if dbDSN == "" {
		if dbDriver == "postgres" {
			return Config{}, fmt.Errorf("AMIRO_DATABASE_URL is required when AMIRO_DATABASE_DRIVER=postgres")
		}
		// Check for existing database file for backwards compatibility
		legacyDBPath := filepath.Join(dataDir, "betterchatbot.db")
		amiroDBPath := filepath.Join(dataDir, "amiro.db")
		if _, err := os.Stat(amiroDBPath); err == nil {
			dbDSN = amiroDBPath
		} else if _, err := os.Stat(legacyDBPath); err == nil {
			dbDSN = legacyDBPath
		} else {
			dbDSN = amiroDBPath
		}
	}

	s3Bucket := getEnv("AMIRO_S3_BUCKET", "BETTERCHATBOT_S3_BUCKET")
	if s3Bucket == "" && dbDriver == "postgres" {
		return Config{}, fmt.Errorf("AMIRO_S3_BUCKET is required when AMIRO_DATABASE_DRIVER=postgres")
	}

	return Config{
		AuthToken:           token,
		AllowedOrigin:       origin,
		AppDataDir:          dataDir,
		BindHost:            bindHost,
		Port:                port,
		DatabaseDriver:      dbDriver,
		DatabaseDSN:         dbDSN,
		S3Bucket:            s3Bucket,
		WorkspaceRoot:       getEnv("AMIRO_WORKSPACE_ROOT", "BETTERCHATBOT_WORKSPACE_ROOT"),
		SandboxNetworkAllow: parseSandboxNetworkAllow(getEnv("AMIRO_SANDBOX_NETWORK_ALLOW", "BETTERCHATBOT_SANDBOX_NETWORK_ALLOW")),
		GitHubAPIBase:       getEnv("AMIRO_GITHUB_API_BASE", "BETTERCHATBOT_GITHUB_API_BASE"),
	}, nil
}

// parseSandboxNetworkAllow splits the comma-separated env value into
// trimmed, non-empty entries. "" (unset) and "," (nothing between commas)
// both yield nil, not a slice of empty strings that would never match
// anything but would still make the allow-list look non-empty.
func parseSandboxNetworkAllow(raw string) []string {
	if raw == "" {
		return nil
	}
	var out []string
	for _, part := range strings.Split(raw, ",") {
		if trimmed := strings.TrimSpace(part); trimmed != "" {
			out = append(out, trimmed)
		}
	}
	return out
}

func randomToken(n int) (string, error) {
	b := make([]byte, n)
	if _, err := rand.Read(b); err != nil {
		return "", err
	}
	return hex.EncodeToString(b), nil
}

func appDataDir() (string, error) {
	if dir := getEnv("AMIRO_APP_DATA_DIR", "BETTERCHATBOT_APP_DATA_DIR"); dir != "" {
		return dir, nil
	}

	home, err := os.UserHomeDir()
	if err != nil {
		return "", err
	}

	switch runtime.GOOS {
	case "darwin":
		amiroDir := filepath.Join(home, "Library", "Application Support", "amiro")
		legacyDir := filepath.Join(home, "Library", "Application Support", "better-chatbot")
		if _, err := os.Stat(amiroDir); err == nil {
			return amiroDir, nil
		}
		if _, err := os.Stat(legacyDir); err == nil {
			return legacyDir, nil
		}
		return amiroDir, nil
	case "windows":
		var baseDir string
		if appData := os.Getenv("APPDATA"); appData != "" {
			baseDir = appData
		} else {
			baseDir = filepath.Join(home, "AppData", "Roaming")
		}
		amiroDir := filepath.Join(baseDir, "amiro")
		legacyDir := filepath.Join(baseDir, "better-chatbot")
		if _, err := os.Stat(amiroDir); err == nil {
			return amiroDir, nil
		}
		if _, err := os.Stat(legacyDir); err == nil {
			return legacyDir, nil
		}
		return amiroDir, nil
	default: // linux and other unix
		var baseDir string
		if xdg := os.Getenv("XDG_DATA_HOME"); xdg != "" {
			baseDir = xdg
		} else {
			baseDir = filepath.Join(home, ".local", "share")
		}
		amiroDir := filepath.Join(baseDir, "amiro")
		legacyDir := filepath.Join(baseDir, "better-chatbot")
		if _, err := os.Stat(amiroDir); err == nil {
			return amiroDir, nil
		}
		if _, err := os.Stat(legacyDir); err == nil {
			return legacyDir, nil
		}
		return amiroDir, nil
	}
}

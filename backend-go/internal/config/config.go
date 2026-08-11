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
)

type Config struct {
	// AuthToken is the shared secret the webview must send on every request.
	// Passed in from Rust via BETTERCHATBOT_AUTH_TOKEN; generated here as a
	// fallback for standalone (non-sidecar) runs, e.g. local dev.
	AuthToken string
	// AllowedOrigin is the exact webview origin CORS allows. Passed in from
	// Rust via BETTERCHATBOT_ALLOWED_ORIGIN; defaults to the Tauri dev origin.
	AllowedOrigin string
	// AppDataDir is the OS-specific app-data root for SQLite/local storage.
	AppDataDir string
	// BindHost is the interface the listener binds. Defaults to 127.0.0.1 --
	// plan section 1 is explicit that this must never be 0.0.0.0 in the real
	// sidecar. Override via BETTERCHATBOT_BIND_HOST only exists for manual
	// LAN testing during development; production/Tauri wiring never sets it.
	BindHost string
	// Port is the TCP port the listener binds. Defaults to 0 (OS-assigned),
	// which is what the real sidecar relies on -- Rust reads the actual port
	// off stdout. Override via BETTERCHATBOT_PORT for a stable, guessable
	// port during manual testing.
	Port int
	// DatabaseDriver selects the GORM dialect: "sqlite" (desktop default)
	// or "postgres" (web deploy). Override via BETTERCHATBOT_DATABASE_DRIVER.
	DatabaseDriver string
	// DatabaseDSN is the dialect-appropriate connection string: a file path
	// under AppDataDir for sqlite, a "postgres://..." URL for postgres.
	// Override via BETTERCHATBOT_DATABASE_URL (required when
	// DatabaseDriver is "postgres" -- there is no sensible default).
	DatabaseDSN string
	// S3Bucket names the bucket internal/storage.S3Storage writes to.
	// Required when DatabaseDriver is "postgres" -- plan section 3 couples
	// "postgres driver" with "web deploy" throughout (auth's desktop
	// auto-login and this storage backend selection both key off the same
	// signal), so a web deploy is assumed to need S3 the same way it needs
	// a real Postgres URL. Unused on desktop (DatabaseDriver "sqlite"),
	// which uses internal/storage.LocalStorage instead.
	S3Bucket string
}

func Load() (Config, error) {
	token := os.Getenv("BETTERCHATBOT_AUTH_TOKEN")
	if token == "" {
		generated, err := randomToken(32)
		if err != nil {
			return Config{}, err
		}
		token = generated
	}

	origin := os.Getenv("BETTERCHATBOT_ALLOWED_ORIGIN")
	if origin == "" {
		origin = "tauri://localhost"
	}

	bindHost := os.Getenv("BETTERCHATBOT_BIND_HOST")
	if bindHost == "" {
		bindHost = "127.0.0.1"
	}

	port := 0
	if raw := os.Getenv("BETTERCHATBOT_PORT"); raw != "" {
		parsed, err := strconv.Atoi(raw)
		if err != nil {
			return Config{}, fmt.Errorf("BETTERCHATBOT_PORT: %w", err)
		}
		port = parsed
	}

	dataDir, err := appDataDir()
	if err != nil {
		return Config{}, err
	}

	dbDriver := os.Getenv("BETTERCHATBOT_DATABASE_DRIVER")
	if dbDriver == "" {
		dbDriver = "sqlite"
	}

	dbDSN := os.Getenv("BETTERCHATBOT_DATABASE_URL")
	if dbDSN == "" {
		if dbDriver == "postgres" {
			return Config{}, fmt.Errorf("BETTERCHATBOT_DATABASE_URL is required when BETTERCHATBOT_DATABASE_DRIVER=postgres")
		}
		dbDSN = filepath.Join(dataDir, "betterchatbot.db")
	}

	s3Bucket := os.Getenv("BETTERCHATBOT_S3_BUCKET")
	if s3Bucket == "" && dbDriver == "postgres" {
		return Config{}, fmt.Errorf("BETTERCHATBOT_S3_BUCKET is required when BETTERCHATBOT_DATABASE_DRIVER=postgres")
	}

	return Config{
		AuthToken:      token,
		AllowedOrigin:  origin,
		AppDataDir:     dataDir,
		BindHost:       bindHost,
		Port:           port,
		DatabaseDriver: dbDriver,
		DatabaseDSN:    dbDSN,
		S3Bucket:       s3Bucket,
	}, nil
}

func randomToken(n int) (string, error) {
	b := make([]byte, n)
	if _, err := rand.Read(b); err != nil {
		return "", err
	}
	return hex.EncodeToString(b), nil
}

func appDataDir() (string, error) {
	if dir := os.Getenv("BETTERCHATBOT_APP_DATA_DIR"); dir != "" {
		return dir, nil
	}

	home, err := os.UserHomeDir()
	if err != nil {
		return "", err
	}

	switch runtime.GOOS {
	case "darwin":
		return filepath.Join(home, "Library", "Application Support", "better-chatbot"), nil
	case "windows":
		if appData := os.Getenv("APPDATA"); appData != "" {
			return filepath.Join(appData, "better-chatbot"), nil
		}
		return filepath.Join(home, "AppData", "Roaming", "better-chatbot"), nil
	default: // linux and other unix
		if xdg := os.Getenv("XDG_DATA_HOME"); xdg != "" {
			return filepath.Join(xdg, "better-chatbot"), nil
		}
		return filepath.Join(home, ".local", "share", "better-chatbot"), nil
	}
}

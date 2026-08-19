package main

import (
	"context"
	"net/http/httptest"
	"path/filepath"
	"strings"
	"testing"

	"amiro/backend/internal/auth"
	"amiro/backend/internal/config"
	"amiro/backend/internal/db"
	"amiro/backend/internal/httpserver"
	"amiro/backend/internal/tui/client"
)

// authOnlyServer is a real httptest.Server standing in for "a stranger's
// process" -- a desktop sidecar on another machine, or another terminal's
// embedded server -- for testing amiro --connect. Only auth routes are
// wired: connectTransport and resolveSession's safety rule (no
// auto-provisioning against a server this process does not own) never
// touch chat at all.
func authOnlyServer(t *testing.T) (baseURL, authToken string) {
	t.Helper()
	dsn := filepath.Join(t.TempDir(), "test.db")
	gdb, err := db.Open(db.DialectSQLite, dsn)
	if err != nil {
		t.Fatalf("db.Open: %v", err)
	}
	authService := auth.NewService(gdb)
	cfg := config.Config{AuthToken: "stranger-shared-secret", AllowedOrigin: "tauri://localhost", AppDataDir: t.TempDir()}
	handler := httpserver.New(cfg, httpserver.Handlers{Auth: authService})
	srv := httptest.NewServer(handler)
	t.Cleanup(srv.Close)
	return srv.URL, cfg.AuthToken
}

// localCfg is a throwaway sidecar-bootstrap config for the *connecting*
// process' own secrets storage -- distinct from the stranger server's own
// config.Config above. AppDataDir is a fresh t.TempDir() every time, so
// stored sessions never leak between tests or touch a real user's app data.
func localCfg(t *testing.T) config.Config {
	t.Helper()
	return config.Config{DatabaseDriver: "sqlite", AppDataDir: t.TempDir()}
}

// TestConnectTransport_RequiresToken is the Phase 5 safety rule's first
// gate: --connect with no --token must fail before a single request is
// attempted, not surface as a generic 401 partway through resolveSession.
func TestConnectTransport_RequiresToken(t *testing.T) {
	baseURL, _ := authOnlyServer(t)
	if _, err := connectTransport(context.Background(), baseURL, ""); err == nil {
		t.Fatalf("connectTransport with no token = nil error, want a clean failure")
	}
}

// TestConnectTransport_RejectsWrongToken proves a wrong shared secret is
// caught at connect time (a real health round trip), not discovered later
// as a stream of failed requests.
func TestConnectTransport_RejectsWrongToken(t *testing.T) {
	baseURL, _ := authOnlyServer(t)
	if _, err := connectTransport(context.Background(), baseURL, "not-the-real-secret"); err == nil {
		t.Fatalf("connectTransport with a wrong token = nil error, want a clean failure")
	}
}

// TestConnectTransport_NeverAutoProvisionsAnIdentity is this phase's central
// safety property, restated from resolveSession's own doc comment for
// --connect specifically: an explicitly-attached server is a stranger's
// process (more so than an implicitly-discovered same-machine sidecar --
// it can name a server on another machine entirely), so with no stored
// session, resolveSession must fail cleanly rather than fabricate a
// desktop-default identity against it.
func TestConnectTransport_NeverAutoProvisionsAnIdentity(t *testing.T) {
	baseURL, authToken := authOnlyServer(t)
	tr, err := connectTransport(context.Background(), baseURL, authToken)
	if err != nil {
		t.Fatalf("connectTransport: %v", err)
	}
	if tr.embedded != nil {
		t.Fatalf("connectTransport's transport has a non-nil embedded server -- it must never start or own one")
	}

	_, err = resolveSession(context.Background(), localCfg(t), tr)
	if err == nil {
		t.Fatalf("resolveSession against a --connect'd server with no stored session = nil error, want a clean failure")
	}
	if strings.Contains(err.Error(), "provisioning") {
		t.Fatalf("resolveSession error = %q, must not attempt to auto-provision an identity against an explicitly-attached server", err)
	}
	if !strings.Contains(err.Error(), "not signed in") {
		t.Fatalf("resolveSession error = %q, want it to say the user is not signed in", err)
	}
}

// TestConnectTransport_UsesAPerServerStoredSession is the safety rule's
// other half: --connect *does* work once a session has actually been
// established for that specific server (the same round trip `amiro auth
// login --connect <url> --token <tok>` performs) -- the failure above is
// about fabricating an identity, not about refusing every identity.
func TestConnectTransport_UsesAPerServerStoredSession(t *testing.T) {
	baseURL, authToken := authOnlyServer(t)
	tr, err := connectTransport(context.Background(), baseURL, authToken)
	if err != nil {
		t.Fatalf("connectTransport: %v", err)
	}
	cfg := localCfg(t)

	// What `amiro auth login --connect` does: register/login directly
	// against the stranger server, then persist the resulting token under
	// this transport's own sessionKey.
	anon := client.New(client.Config{BaseURL: baseURL, AuthToken: authToken})
	sessionToken, err := anon.Register(context.Background(), "Ada", "ada@example.com", "hunter2hunter2")
	if err != nil {
		t.Fatalf("Register: %v", err)
	}
	store := secretsStore(cfg)
	if err := store.Set(context.Background(), tr.sessionKey, sessionToken); err != nil {
		t.Fatalf("store.Set: %v", err)
	}
	t.Cleanup(func() { store.Delete(context.Background(), tr.sessionKey) })

	authed, err := resolveSession(context.Background(), cfg, tr)
	if err != nil {
		t.Fatalf("resolveSession with a stored per-server session = %v, want nil", err)
	}
	name, email, err := authed.Whoami(context.Background())
	if err != nil {
		t.Fatalf("Whoami: %v", err)
	}
	if name != "Ada" || email != "ada@example.com" {
		t.Fatalf("Whoami = (%q, %q), want (Ada, ada@example.com)", name, email)
	}
}

// TestConnectTransport_SessionIsScopedPerServer is the regression this
// phase exists to prevent: a session stored for one server (in particular,
// this machine's own attach-or-embed session, under the shared
// sessionSecretKey attach-or-embed transports use) must never be read back
// and tried against a different, explicitly-connected server -- and vice
// versa. Reusing one global session slot for both would mean logging into
// a remote --connect target could silently overwrite, or be shadowed by,
// this machine's own desktop-default session.
func TestConnectTransport_SessionIsScopedPerServer(t *testing.T) {
	baseURL, authToken := authOnlyServer(t)
	tr, err := connectTransport(context.Background(), baseURL, authToken)
	if err != nil {
		t.Fatalf("connectTransport: %v", err)
	}
	if tr.sessionKey == sessionSecretKey {
		t.Fatalf("connectTransport's sessionKey equals the shared attach-or-embed sessionSecretKey -- sessions would collide across servers")
	}
	cfg := localCfg(t)
	store := secretsStore(cfg)

	// A session parked under the *shared* attach-or-embed key (as if this
	// machine's own desktop app had already logged in) must not be picked
	// up for an unrelated --connect target.
	if err := store.Set(context.Background(), sessionSecretKey, "some-other-servers-token"); err != nil {
		t.Fatalf("store.Set: %v", err)
	}
	t.Cleanup(func() { store.Delete(context.Background(), sessionSecretKey) })

	if _, err := resolveSession(context.Background(), cfg, tr); err == nil {
		t.Fatalf("resolveSession picked up the attach-or-embed session for an explicit --connect target -- sessions are not actually scoped per server")
	}
}

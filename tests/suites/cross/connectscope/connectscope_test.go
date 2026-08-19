// Package connectscope_test proves Phase 7 Exit Criterion 2's second half:
// "the --connect session-scoping rule ... a session for one server must
// never be tried against another, and that is a security property, not a
// nicety" (docs/testing/phases/phase-07-cross-surface.md).
//
// backend-go/cmd/amiro's own unit tests (connect_test.go) already prove
// this at the function level: connectTransport/resolveSession/secretsStore
// called directly as Go functions. What this suite adds is the same
// property proven through a REAL amiro binary under a REAL PTY, reading a
// REAL on-disk keys.json the way a real user's session store would be
// laid out -- see backend-go/cmd/amiro/session.go's sessionKeyForServer
// ("amiro:session:" + url) and internal/secrets/keyring_store.go's
// keys.json fallback (the same file harness.Harness.PTY() already writes
// the plain "amiro:session" key into for attach-or-embed tests).
//
// Two independent backends stand in for "server A" and "server B" --
// distinct ports, distinct sidecar tokens, distinct seeded admin sessions.
// A stale/foreign session is planted under A's key, and amiro is pointed
// at B with --connect; the assertion is that B is never signed in using
// A's identity. A positive control (a correctly-scoped session for B)
// proves the failure above is really about scoping, not --connect being
// broken outright.
package connectscope_test

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"testing"
	"time"

	"amiro/tests/harness"
	"amiro/tests/harness/apiclient"
	"amiro/tests/harness/backend"
	"amiro/tests/harness/seed"
)

func startServer(t *testing.T, h *harness.Harness, name string) (*backend.Backend, string) {
	t.Helper()
	be, err := backend.Start(context.Background(), backend.Options{
		RepoRoot: h.RepoRoot,
		BaseDir:  h.BaseDir,
		Config:   h.Config,
		Log:      h.Log,
		TestID:   h.TestID + "-" + name,
		Surface:  h.Surface,
		Address:  h.Surface + "/connectscope/" + name,
	})
	if err != nil {
		t.Fatalf("starting backend %s: %v", name, err)
	}
	t.Cleanup(func() { _ = be.Stop(context.Background()) })

	client := apiclient.New(apiclient.Options{
		BaseURL: be.URL,
		Token:   be.Token,
		Log:     h.Log,
		Surface: h.Surface,
		Address: h.Surface + "/connectscope/" + name,
	})
	state, err := seed.Apply(context.Background(), client, h.Config, seed.Default)
	if err != nil {
		t.Fatalf("seeding backend %s: %v", name, err)
	}
	admin := state.Identity("admin")
	if admin == nil {
		t.Fatalf("backend %s: no seeded admin identity", name)
	}
	return be, admin.Token
}

func writeKeys(t *testing.T, appDataDir string, entries map[string]string) {
	t.Helper()
	if err := os.MkdirAll(appDataDir, 0o755); err != nil {
		t.Fatal(err)
	}
	data, err := json.Marshal(entries)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(appDataDir, "keys.json"), data, 0o600); err != nil {
		t.Fatal(err)
	}
}

func TestConnectScope_ForeignSessionUnderAnotherServersKeyIsNeverAccepted(t *testing.T) {
	h := harness.New(t, harness.NoBackend(), harness.Tags("smoke"))

	serverA, sessionA := startServer(t, h, "a")
	serverB, _ := startServer(t, h, "b")

	appDataDir := filepath.Join(h.Dir(), "connect-appdata")
	// A real session exists, but it is stored under SERVER A's key --
	// exactly what `amiro auth login --connect <A> --token <tokA>` would
	// have written. Nothing is stored for server B.
	writeKeys(t, appDataDir, map[string]string{
		"amiro:session:" + serverA.URL: sessionA,
	})

	sess := h.PTY(
		harness.PTYAppDataDir(appDataDir),
		harness.PTYArgs("--connect", serverB.URL, "--token", serverB.Token),
	)
	defer sess.Close()

	if err := sess.WaitForText("not signed in", 15*time.Second); err != nil {
		t.Fatalf("connecting to server B with only server A's session stored should have refused to sign in, "+
			"instead of silently reusing A's identity: %v\nframe:\n%s", err, sess.Frame())
	}
	if sess.Contains("Ask Amiro") {
		t.Fatalf("amiro reached the chat prompt against server B using a session that was only ever valid for "+
			"server A -- session scoping did not hold\nframe:\n%s", sess.Frame())
	}
}

func TestConnectScope_SharedAttachOrEmbedSessionIsNeverAcceptedForConnect(t *testing.T) {
	h := harness.New(t, harness.NoBackend(), harness.Tags("smoke"))

	serverB, _ := startServer(t, h, "b")

	appDataDir := filepath.Join(h.Dir(), "connect-appdata")
	// A session exists under the PLAIN shared key attach-or-embed uses --
	// never under any per-server key. --connect must not fall back to it,
	// even though the value itself would otherwise be a syntactically
	// plausible token.
	writeKeys(t, appDataDir, map[string]string{
		"amiro:session": "not-a-real-per-server-session-token",
	})

	sess := h.PTY(
		harness.PTYAppDataDir(appDataDir),
		harness.PTYArgs("--connect", serverB.URL, "--token", serverB.Token),
	)
	defer sess.Close()

	if err := sess.WaitForText("not signed in", 15*time.Second); err != nil {
		t.Fatalf("--connect should never fall back to the plain shared \"amiro:session\" key: %v\nframe:\n%s",
			err, sess.Frame())
	}
}

func TestConnectScope_CorrectlyScopedSessionWorks(t *testing.T) {
	h := harness.New(t, harness.NoBackend(), harness.Tags("smoke"))

	serverB, sessionB := startServer(t, h, "b")

	appDataDir := filepath.Join(h.Dir(), "connect-appdata")
	writeKeys(t, appDataDir, map[string]string{
		"amiro:session:" + serverB.URL: sessionB,
	})

	sess := h.PTY(
		harness.PTYAppDataDir(appDataDir),
		harness.PTYArgs("--connect", serverB.URL, "--token", serverB.Token),
	)
	defer sess.Close()

	if err := sess.WaitForText("Ask Amiro", 15*time.Second); err != nil {
		t.Fatalf("a session correctly scoped to server B's own URL should have worked: %v\nframe:\n%s",
			err, sess.Frame())
	}
}

package main

import (
	"context"
	"fmt"
	"os"

	"amiro/backend/internal/config"
	"amiro/backend/internal/db"
	"amiro/backend/internal/secrets"
	"amiro/backend/internal/tui/client"
)

// sessionSecretKey is the provider name internal/secrets stores the TUI's
// session token under. It is not a provider API key -- KeyStore is reused
// rather than duplicated, per plan §2.5 ("token stored via internal/secrets
// ... existing file-store fallback for headless Linux/SSH"), and this is
// the one string that has to agree between `amiro auth login/logout/whoami`
// and every command that needs to be signed in already.
const sessionSecretKey = "amiro:session"

func secretsStore(cfg config.Config) secrets.KeyStore {
	return secrets.New(cfg.DatabaseDriver == db.DialectSQLite, cfg.AppDataDir)
}

// sessionKeyForServer is the secrets-store key an explicit `amiro --connect
// <url>` session is stored under -- distinct from sessionSecretKey, and
// distinct per url, so a session obtained by logging into one stranger's
// server is never read back and tried against a different one. Without
// this, --connect and attach-or-embed would share one global "the signed-in
// user" slot, and logging into a remote server would silently overwrite
// (or be overwritten by) this machine's own desktop-default session.
func sessionKeyForServer(url string) string {
	return sessionSecretKey + ":" + url
}

// resolveSession returns t.Client authenticated as whoever is signed in.
//
// A stored session always wins when it still validates -- it is what `amiro
// auth login` produced, a real account the user chose. Only when nothing is
// stored yet, and only when this process owns the server it's talking to
// (embedded, not attached), does it fall back to auto-provisioning the
// single desktop-default local user: the same zero-setup convenience the
// desktop app's own EnsureDesktopDefaultUser existed for before login
// became mandatory there, unused until now. That result is persisted, so
// this fallback only ever fires once -- the next run finds a stored session
// and takes the first branch.
//
// An attached server (someone else's process, someone else's account) never
// auto-provisions: fabricating a session for a stranger's backend is not a
// convenience, it's a way to end up acting as a user nobody chose. This is
// exactly the case for an explicit `amiro --connect` transport too (t.embedded
// is nil for it, same as implicit attach) -- it is, if anything, more of a
// stranger's process than a discovered same-machine sidecar, since it can
// name a server on another machine entirely.
func resolveSession(ctx context.Context, cfg config.Config, t *transport) (*client.HTTPClient, error) {
	store := secretsStore(cfg)

	if token, ok, err := store.Get(ctx, t.sessionKey); err == nil && ok {
		authed := t.Client.WithSessionToken(token)
		if _, _, err := authed.Whoami(ctx); err == nil {
			return authed, nil
		}
		// Stored token is stale (expired session, deleted account) -- fall
		// through to whatever this transport can still offer.
	}

	if t.embedded == nil {
		return nil, fmt.Errorf("not signed in -- run `amiro auth login` (attached to an existing server, so amiro cannot auto-provision an account for it)")
	}

	_, sess, err := t.embedded.App.Auth.EnsureDesktopDefaultUser(ctx)
	if err != nil {
		return nil, fmt.Errorf("provisioning local user: %w", err)
	}
	if err := store.Set(ctx, t.sessionKey, sess.Token); err != nil {
		fmt.Fprintf(os.Stderr, "amiro: could not remember this session: %v\n", err)
	}
	return t.Client.WithSessionToken(sess.Token), nil
}

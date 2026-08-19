package client

import (
	"context"

	"amiro/backend/internal/appwiring"
)

// Discover looks for a live server already running against appDataDir --
// the desktop app's sidecar, or an `amiro` from another terminal -- and
// returns an HTTPClient for it if one answers.
//
// ok is false both when no lock file exists and when one does but nothing
// answers at the port it names (a stale file from a process that died
// without RemoveLock, e.g. SIGKILL): either way, the caller's answer is the
// same -- start an embedded server, see embedded.go.
func Discover(ctx context.Context, appDataDir string) (c *HTTPClient, ok bool) {
	lock, found, err := appwiring.ReadLock(appDataDir)
	if err != nil || !found {
		return nil, false
	}
	candidate := New(Config{
		BaseURL:   appwiring.LoopbackURL(lock.Port),
		AuthToken: lock.Token,
	})
	if !candidate.Health(ctx) {
		return nil, false
	}
	return candidate, true
}

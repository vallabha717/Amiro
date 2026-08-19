package main

import (
	"context"
	"fmt"

	"amiro/backend/internal/config"
	"amiro/backend/internal/tui/client"
)

// transport is a resolved connection to a backend -- either attached to a
// server someone else started, or embedded in this process. Either way,
// Client is a plain client.HTTPClient from here on; the rest of the program
// never learns which.
type transport struct {
	Client   *client.HTTPClient
	embedded *client.Embedded // nil when attached; the thing this process must Close on the way out otherwise

	// sessionKey is where resolveSession looks for (and stores) this
	// transport's stored session, in internal/secrets. attach-or-embed
	// transports (implicit discovery or this process's own embedded
	// server) all share sessionSecretKey -- they are, by construction, this
	// machine's one desktop-default account. An explicit --connect
	// transport gets its own key, scoped to the server it names
	// (sessionKeyForServer) -- see resolveSession's doc comment for why a
	// session for one stranger's server must never be tried against
	// another.
	sessionKey string
}

func (t *transport) Close() {
	if t.embedded != nil {
		t.embedded.Close()
	}
}

// resolveTransport is the attach-or-embed rule (plan §2.2): find a live
// server already running for cfg.AppDataDir -- the desktop app's sidecar,
// or another `amiro` -- and attach to it, sharing its database. Otherwise
// start one in-process on a loopback port nobody outside this process ever
// sees, over the same internal/appwiring every entrypoint uses.
func resolveTransport(ctx context.Context, cfg config.Config) (*transport, error) {
	if c, ok := client.Discover(ctx, cfg.AppDataDir); ok {
		return &transport{Client: c, sessionKey: sessionSecretKey}, nil
	}

	embedded, err := client.StartEmbedded(ctx, cfg)
	if err != nil {
		return nil, fmt.Errorf("starting embedded server: %w", err)
	}
	return &transport{Client: embedded.Client, embedded: embedded, sessionKey: sessionSecretKey}, nil
}

// connectTransport is amiro --connect's transport (plan Appendix A):
// explicit attach to a server this process neither discovers, starts, nor
// owns -- a running desktop sidecar on this machine addressed directly, or
// one on another machine entirely. It never embeds (embedded stays nil, so
// resolveSession's auto-provisioning branch never fires for it -- the same
// safety rule implicit attach already follows, restated in connect.go and
// resolveSession's own doc comment) and its session is stored under a key
// scoped to connectURL, never sessionSecretKey.
func connectTransport(ctx context.Context, connectURL, token string) (*transport, error) {
	c, err := client.Connect(ctx, connectURL, token)
	if err != nil {
		return nil, err
	}
	return &transport{Client: c, sessionKey: sessionKeyForServer(connectURL)}, nil
}

// resolveConnection is the one place cmd/amiro chooses between attach-or-
// embed discovery and an explicit --connect: every entrypoint that needs a
// transport (the TUI itself, and each `auth` subcommand) calls this rather
// than picking between resolveTransport and connectTransport itself.
func resolveConnection(ctx context.Context, cfg config.Config, connectURL, token string) (*transport, error) {
	if connectURL != "" {
		return connectTransport(ctx, connectURL, token)
	}
	return resolveTransport(ctx, cfg)
}

package client

import (
	"context"
	"fmt"
)

// Connect builds an HTTPClient for a server this process does not own and
// did not discover -- amiro --connect <url> --token <tok> (plan Appendix
// A), a running desktop sidecar or another machine entirely, distinct from
// Discover's implicit "is a sidecar already running for this AppDataDir"
// lookup and from StartEmbedded's "start one ourselves."
//
// token is that server's shared secret (X-Amiro-Token, middleware.
// RequireToken's gate) -- required on every request it accepts. There is no
// lock file to read one from here, so a caller with no token cannot get
// past that server's front door at all; Connect fails immediately rather
// than trying anyway and surfacing an opaque 401 from deep inside a stream.
//
// Connect never falls back to anything -- no embed, no auto-provisioned
// identity. See cmd/amiro/session.go's resolveSession doc comment: an
// explicitly-attached server is a stranger's process, and fabricating a
// session against it is not a convenience.
func Connect(ctx context.Context, baseURL, token string) (*HTTPClient, error) {
	if baseURL == "" {
		return nil, fmt.Errorf("client: --connect requires a URL")
	}
	if token == "" {
		return nil, fmt.Errorf("client: --connect requires --token (the server's shared secret)")
	}
	c := New(Config{BaseURL: baseURL, AuthToken: token})
	if !c.Health(ctx) {
		return nil, fmt.Errorf("client: no server answered at %s", baseURL)
	}
	return c, nil
}

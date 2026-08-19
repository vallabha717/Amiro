package client

import (
	"context"
	"fmt"
	"log"
	"net"
	"net/http"
	"strconv"
	"time"

	"amiro/backend/internal/appwiring"
	"amiro/backend/internal/config"
	"amiro/backend/internal/httpserver"
	"amiro/backend/internal/middleware"
)

// Embedded is a server started in-process for a terminal that found no
// sidecar to attach to (Discover returned ok=false). It is built from
// internal/appwiring the same way cmd/server/main.go is -- one object graph,
// used by every entrypoint, so the embedded path cannot drift from the
// sidecar's (appwiring's own doc comment explains why that matters: a
// second copy of this assembly is exactly how a dependency quietly stops
// reaching the handler that needs it).
type Embedded struct {
	App    *appwiring.App
	Client *HTTPClient

	listener net.Listener
	server   *http.Server
	port     int
	bindHost string
}

// EmbeddedOptions widens StartEmbedded past its original job of serving
// one process's own client on a port nobody else sees. `amiro serve` and
// `amiro --serve` need the same object graph reachable from a browser,
// which means choosing the bind address and hanging the dashboard off it.
//
// The zero value is exactly the original behaviour: loopback, OS-assigned
// port, no UI, sidecar-style guards.
type EmbeddedOptions struct {
	// BindHost is the interface to listen on. Empty means 127.0.0.1.
	// Anything else is a deliberate choice by the caller, who is
	// responsible for having warned the user -- see cmd/amiro/serve_cmd.go.
	BindHost string
	// Port is the TCP port. Zero means OS-assigned.
	Port int
	// UI, AllowedOrigins and RateLimit are passed straight through to
	// httpserver.Options; see there.
	UI             http.Handler
	AllowedOrigins []string
	RateLimit      *middleware.RateLimitConfig
}

func (o EmbeddedOptions) bindHost() string {
	if o.BindHost == "" {
		return "127.0.0.1"
	}
	return o.BindHost
}

// StartEmbedded builds the whole backend and serves it on a loopback port
// nobody but this process's own Client will ever dial. It also writes the
// discovery lock file, so a second `amiro` started against the same
// AppDataDir attaches to this one instead of starting a third backend.
func StartEmbedded(ctx context.Context, cfg config.Config) (*Embedded, error) {
	return StartEmbeddedWith(ctx, cfg, EmbeddedOptions{})
}

// StartEmbeddedWith is StartEmbedded with the bind address and the
// dashboard exposed.
func StartEmbeddedWith(ctx context.Context, cfg config.Config, opts EmbeddedOptions) (*Embedded, error) {
	app, err := appwiring.New(ctx, cfg)
	if err != nil {
		return nil, fmt.Errorf("client: start embedded server: %w", err)
	}

	listener, err := net.Listen("tcp", net.JoinHostPort(opts.bindHost(), strconv.Itoa(opts.Port)))
	if err != nil {
		app.Close()
		return nil, fmt.Errorf("client: listen: %w", err)
	}
	port := listener.Addr().(*net.TCPAddr).Port

	if err := app.AttachPort(ctx, port); err != nil {
		listener.Close()
		app.Close()
		return nil, fmt.Errorf("client: attach port: %w", err)
	}

	if err := appwiring.WriteLock(cfg.AppDataDir, port, cfg.AuthToken); err != nil {
		// Not fatal: this process still serves itself fine, it just won't be
		// discoverable by a second `amiro` invocation.
		log.Printf("client: discovery lock: %v", err)
	}

	// A served dashboard is same-origin with the API, so it needs neither
	// the shared-secret header (which it could not be given privately
	// anyway) nor the any-loopback-port CORS allowance. Both switches move
	// together with UI for exactly that reason.
	server := &http.Server{Handler: httpserver.NewWithOptions(cfg, app.Handlers, httpserver.Options{
		UI:                     opts.UI,
		BrowserAuth:            opts.UI != nil,
		AllowedOrigins:         opts.AllowedOrigins,
		LoopbackOriginWildcard: opts.UI == nil,
		RateLimit:              opts.RateLimit,
	})}
	go func() {
		if err := server.Serve(listener); err != nil && err != http.ErrServerClosed {
			log.Printf("client: embedded server: %v", err)
		}
	}()

	return &Embedded{
		App:      app,
		Client:   New(Config{BaseURL: appwiring.LoopbackURL(port), AuthToken: cfg.AuthToken}),
		listener: listener,
		server:   server,
		port:     port,
		bindHost: opts.bindHost(),
	}, nil
}

// Port is the TCP port the embedded server actually bound -- the only way
// to learn it when Options.Port was left at zero.
func (e *Embedded) Port() int { return e.port }

// BindHost is the interface the embedded server actually bound.
func (e *Embedded) BindHost() string { return e.bindHost }

// Close shuts the embedded server down and releases everything StartEmbedded
// started, in the order a caller expects: stop taking requests, remove the
// discovery file so nothing else tries to attach to a server that's already
// on its way out, then release the backend.
func (e *Embedded) Close() {
	shutdownCtx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	if err := e.server.Shutdown(shutdownCtx); err != nil {
		log.Printf("client: embedded server shutdown: %v", err)
	}
	if err := appwiring.RemoveLock(e.App.Config.AppDataDir); err != nil {
		log.Printf("client: discovery lock cleanup: %v", err)
	}
	e.App.Close()
}

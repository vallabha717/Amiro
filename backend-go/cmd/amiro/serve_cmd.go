package main

import (
	"context"
	"flag"
	"fmt"
	"net"
	"net/http"
	"os"
	"os/signal"
	"path/filepath"
	"strconv"
	"strings"
	"syscall"

	"github.com/pkg/browser"

	"amiro/backend/internal/config"
	"amiro/backend/internal/middleware"
	"amiro/backend/internal/tui/client"
	"amiro/backend/internal/web"
)

// loopbackHosts are the bind addresses that reach only this machine.
// Anything else is a network-reachable bind and triggers the extra
// requirements in serveGuards.
var loopbackHosts = map[string]bool{
	"127.0.0.1": true,
	"::1":       true,
	"localhost": true,
}

// serveConfig is what both entrypoints -- `amiro serve` and `amiro
// --serve` -- resolve their flags into, so the two cannot drift on the
// part that actually matters (which interface, with which guards).
type serveConfig struct {
	Host           string
	Port           int
	UIDir          string
	NoUI           bool
	AllowedOrigins []string
	Open           bool
}

func (c serveConfig) isLoopback() bool { return loopbackHosts[c.Host] }

// runServe is `amiro serve`: the API plus the dashboard, on an interface
// the user chose, until interrupted.
//
// This is a different thing from cmd/server, which is the Tauri sidecar:
// that one is pinned to loopback by design, prints PORT= for Rust to read,
// and serves no UI because the webview loads its own. `amiro serve` is for
// the case the sidecar deliberately does not cover -- reaching Amiro from
// another device, or just from a browser instead of the desktop shell.
func runServe(args []string) error {
	fs := flag.NewFlagSet("amiro serve", flag.ContinueOnError)
	host := fs.String("host", "127.0.0.1", "interface to bind; 0.0.0.0 makes the dashboard reachable from other machines")
	port := fs.Int("port", 0, "port to bind (0 = pick a free one)")
	dir := fs.String("C", "", "workspace root for the agent's file tools (default: current directory)")
	uiDir := fs.String("ui-dir", "", "serve the dashboard from this directory instead of the bundle compiled into this binary")
	noUI := fs.Bool("no-ui", false, "serve the API only, without the dashboard (callers must send the shared secret, as with the desktop sidecar)")
	open := fs.Bool("open", false, "open the dashboard in a browser once it is ready")
	token := fs.String("token", "", "shared secret for programmatic clients (generated and printed if omitted)")
	var origins stringList
	fs.Var(&origins, "allow-origin", "extra origin allowed to call the API cross-origin; repeatable")
	if err := fs.Parse(args); err != nil {
		return err
	}

	sc := serveConfig{
		Host:           *host,
		Port:           *port,
		UIDir:          *uiDir,
		NoUI:           *noUI,
		AllowedOrigins: origins,
		Open:           *open,
	}

	workspaceRoot, err := resolveWorkspaceRoot(*dir)
	if err != nil {
		return err
	}

	cfg, err := config.Load()
	if err != nil {
		return fmt.Errorf("config: %w", err)
	}
	cfg.WorkspaceRoot = workspaceRoot
	if *token != "" {
		cfg.AuthToken = *token
	}
	cfg.BindHost = sc.Host
	cfg.Port = sc.Port

	opts, err := embeddedOptions(sc, cfg)
	if err != nil {
		return err
	}

	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()

	// Refuse to start a second backend against a database another one
	// already has open. attach-or-embed (serve.go) exists precisely
	// because two processes writing one SQLite file is how a desktop app
	// corrupts its own state; `serve` is not an exception to that.
	if _, ok := client.Discover(ctx, cfg.AppDataDir); ok {
		return fmt.Errorf("another Amiro backend is already running for %s\n"+
			"  quit the desktop app (or the other `amiro`) first -- two backends must not share one database", cfg.AppDataDir)
	}

	embedded, err := client.StartEmbeddedWith(ctx, cfg, opts)
	if err != nil {
		return err
	}
	defer embedded.Close()

	// The same stdout line cmd/server prints for Rust to read. It is the
	// only machine-readable thing here -- the banner below is for a
	// person and goes to stderr -- so a script that needs the port when
	// --port was left at 0 has one line to parse, in the format the
	// project already uses.
	fmt.Printf("PORT=%d\n", embedded.Port())

	url := dashboardURL(sc.Host, embedded.Port())
	printServeBanner(sc, cfg, embedded.Port(), opts.UI != nil)

	if sc.Open && opts.UI != nil {
		if err := browser.OpenURL(url); err != nil {
			fmt.Fprintf(os.Stderr, "could not open a browser: %v\n", err)
		}
	}

	<-ctx.Done()
	fmt.Fprintln(os.Stderr, "\nshutting down...")
	return nil
}

// embeddedOptions turns resolved flags into the transport options, and is
// where the network-bind safety rules live so both entrypoints get them.
func embeddedOptions(sc serveConfig, cfg config.Config) (client.EmbeddedOptions, error) {
	opts := client.EmbeddedOptions{
		BindHost:       sc.Host,
		Port:           sc.Port,
		AllowedOrigins: sc.AllowedOrigins,
	}

	if !sc.NoUI {
		ui, ok := resolveUI(sc.UIDir)
		if !ok {
			if sc.UIDir != "" {
				return opts, fmt.Errorf("--ui-dir %s does not contain a built dashboard (no index.html)", sc.UIDir)
			}
			return opts, fmt.Errorf("this build carries no dashboard bundle\n" +
				"  build one with:  pnpm build && ./scripts/build-ui.sh\n" +
				"  then rebuild:    go build -tags embedui ./cmd/amiro\n" +
				"  or point at an existing export with --ui-dir ../out, or run with --no-ui")
		}
		opts.UI = ui
	}

	if !sc.isLoopback() {
		// A token that is empty or predictable is worse than no token at
		// all, because everything downstream assumes it means something.
		// config.Load generates one when the environment supplies none, so
		// this is a guard against an explicitly blank --token, not an
		// expected path.
		if strings.TrimSpace(cfg.AuthToken) == "" {
			return opts, fmt.Errorf("--host %s needs a shared secret for programmatic clients; --token must not be empty", sc.Host)
		}
		limit := middleware.AuthRateLimit()
		opts.RateLimit = &limit
	}

	return opts, nil
}

// resolveUI prefers an explicit directory over the compiled-in bundle, so
// a frontend change can be tested against a released binary without a Go
// rebuild.
func resolveUI(dir string) (http.Handler, bool) {
	if dir != "" {
		h, ok := web.NewFromDir(dir)
		if !ok {
			return nil, false
		}
		return h, true
	}
	h, ok := web.New()
	if !ok {
		return nil, false
	}
	return h, true
}

func resolveWorkspaceRoot(dir string) (string, error) {
	if dir == "" {
		dir = "."
	}
	abs, err := filepath.Abs(dir)
	if err != nil {
		return "", fmt.Errorf("resolving workspace root: %w", err)
	}
	return abs, nil
}

// dashboardURL is what a person should type. A wildcard bind has no single
// address, so name a reachable one rather than printing "0.0.0.0", which
// is not a destination.
func dashboardURL(host string, port int) string {
	switch host {
	case "0.0.0.0", "::", "":
		host = firstNonLoopbackIP()
	}
	return "http://" + net.JoinHostPort(host, strconv.Itoa(port))
}

func firstNonLoopbackIP() string {
	addrs, err := net.InterfaceAddrs()
	if err != nil {
		return "127.0.0.1"
	}
	for _, addr := range addrs {
		ipnet, ok := addr.(*net.IPNet)
		if !ok || ipnet.IP.IsLoopback() {
			continue
		}
		if ip4 := ipnet.IP.To4(); ip4 != nil {
			return ip4.String()
		}
	}
	return "127.0.0.1"
}

func printServeBanner(sc serveConfig, cfg config.Config, port int, hasUI bool) {
	out := os.Stderr

	if !sc.isLoopback() {
		fmt.Fprintf(out, "\n  WARNING: bound to %s -- Amiro is now reachable by every host on this network.\n", sc.Host)
		fmt.Fprintf(out, "  It runs shell commands and reads files in %s on behalf of whoever signs in.\n", cfg.WorkspaceRoot)
		fmt.Fprintf(out, "  Anyone who can reach this port sees the sign-in page. Do not do this on a network you do not trust.\n\n")
	}

	if hasUI {
		fmt.Fprintf(out, "  dashboard   %s\n", dashboardURL(sc.Host, port))
	} else {
		fmt.Fprintf(out, "  dashboard   (disabled, --no-ui)\n")
	}
	fmt.Fprintf(out, "  api         %s\n", dashboardURL(sc.Host, port))
	fmt.Fprintf(out, "  workspace   %s\n", cfg.WorkspaceRoot)
	fmt.Fprintf(out, "  token       %s\n", cfg.AuthToken)
	fmt.Fprintf(out, "\n  connect a terminal:  amiro --connect %s --token %s\n\n",
		dashboardURL(sc.Host, port), cfg.AuthToken)
	fmt.Fprintln(out, "  ctrl+c to stop")
}

// stringList collects a repeatable flag.
type stringList []string

func (s *stringList) String() string { return strings.Join(*s, ",") }
func (s *stringList) Set(v string) error {
	*s = append(*s, v)
	return nil
}

// serveTransport is `amiro --serve`'s transport: always embedded, never
// attached, bound where the user asked, with the dashboard on it. It
// returns the URL the caller should show the user.
//
// Unlike resolveTransport it refuses to fall back to attaching. Attaching
// would give the TUI a working backend and silently no dashboard, which is
// the one outcome someone who typed --serve did not want; and starting a
// second backend anyway would put two writers on one SQLite file. So a
// discovered server is an error with an explanation, not a fallback.
func serveTransport(ctx context.Context, cfg config.Config, sc serveConfig) (*transport, string, error) {
	if _, ok := client.Discover(ctx, cfg.AppDataDir); ok {
		return nil, "", fmt.Errorf("another Amiro backend is already running for %s\n"+
			"  --serve needs its own backend, and two must not share one database\n"+
			"  quit the desktop app (or the other `amiro`) first, or run plain `amiro` to attach to it", cfg.AppDataDir)
	}

	cfg.BindHost = sc.Host
	cfg.Port = sc.Port

	opts, err := embeddedOptions(sc, cfg)
	if err != nil {
		return nil, "", err
	}

	embedded, err := client.StartEmbeddedWith(ctx, cfg, opts)
	if err != nil {
		return nil, "", fmt.Errorf("starting embedded server: %w", err)
	}

	url := dashboardURL(sc.Host, embedded.Port())
	if !sc.isLoopback() {
		// The alt-screen swallows anything written after the program
		// starts, so the warning goes out now, before it opens. The URL
		// itself also lands in the status bar, where it stays readable.
		printServeBanner(sc, cfg, embedded.Port(), opts.UI != nil)
	}

	return &transport{Client: embedded.Client, embedded: embedded, sessionKey: sessionSecretKey}, url, nil
}

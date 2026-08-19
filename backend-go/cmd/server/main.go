// Command server is the Tauri sidecar entrypoint. It binds an OS-assigned
// loopback port, prints that port on stdout for Rust to read off the spawned
// child, and serves the API behind the shared-secret + CORS guards until it
// receives a shutdown signal.
//
// The object graph it serves is built by internal/appwiring, not here: the
// terminal client and the headless runner need the same graph, and three
// copies of it would drift (see that package's doc comment). What remains
// here is what is genuinely the sidecar's own job -- signals, a listener,
// the PORT line Rust reads, and graceful shutdown.
package main

import (
	"context"
	"fmt"
	"io"
	"log"
	"net"
	"net/http"
	"os"
	"os/signal"
	"strconv"
	"strings"
	"syscall"
	"time"

	"amiro/backend/internal/appwiring"
	"amiro/backend/internal/config"
	"amiro/backend/internal/httpserver"
	"amiro/backend/internal/pricing"
	"amiro/backend/internal/web"
)

func main() {
	// Registered before anything else so there is no window where a SIGTERM
	// (Rust's normal kill-on-exit) or SIGINT (Ctrl+C in dev) could hit the
	// default disposition and skip graceful shutdown -- verified by
	// tests/e2e/sidecar_test.go's SIGTERM test, which caught this race when
	// the registration used to happen after the listener was already up.
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()

	// Plan §1's kill-on-abrupt-quit guard, Go side (see the comment below,
	// by the listener, for the Rust half). SIGKILL of the Tauri parent
	// can't be caught by anyone -- not Rust, not this process -- but the
	// kernel closes every fd the parent held the instant it dies,
	// including the write end of this process's stdin, which Tauri's
	// sidecar plumbing keeps piped open for the whole child lifetime.
	// Watching for that EOF is the signal a caught SIGTERM would have
	// been. Gated on stdin actually being a pipe: exec.Cmd's default,
	// unset Stdin reads as the null device and returns EOF on the very
	// first read, and unconditionally treating that as "shut down" would
	// kill every sidecar this test suite starts along with every bare
	// `go run ./cmd/server` invoked from a terminal.
	if fi, err := os.Stdin.Stat(); err == nil && fi.Mode()&os.ModeNamedPipe != 0 {
		go func() {
			_, _ = io.Copy(io.Discard, os.Stdin)
			fmt.Fprintln(os.Stderr, "stdin closed -- parent process is gone, shutting down")
			stop()
		}()
	}

	cfg, err := config.Load()
	if err != nil {
		log.Fatalf("config: %v", err)
	}

	// Warm up and start background pricing sync immediately on desktop launch.
	_ = pricing.DefaultCatalog()

	if os.Getenv("AMIRO_AUTH_TOKEN") == "" && os.Getenv("BETTERCHATBOT_AUTH_TOKEN") == "" {
		fmt.Fprintf(os.Stderr, "dev mode: no AMIRO_AUTH_TOKEN supplied, generated one: %s\n", cfg.AuthToken)
	}

	// Desktop builds (sqlite driver) now require sign-up/login -- auto-login
	// disabled. Users must create an account and authenticate before
	// accessing the app.
	app, err := appwiring.New(context.Background(), cfg)
	if err != nil {
		log.Fatalf("%v", err)
	}
	defer app.Close()

	if app.WorkspaceRoot != "" {
		log.Printf("agent file tools enabled, workspace root: %s", app.WorkspaceRoot)
		if langs := app.LanguageServers(); len(langs) > 0 {
			log.Printf("language servers available: %s", strings.Join(langs, ", "))
		}
	}

	// cfg.BindHost defaults to 127.0.0.1 -- per plan §1, never 0.0.0.0 in the
	// real sidecar; only BETTERCHATBOT_BIND_HOST (dev/test-only) overrides
	// it. cfg.Port defaults to 0 ("OS picks a free port"), read back from
	// listener.Addr() below; BETTERCHATBOT_PORT pins it for manual testing.
	addr := net.JoinHostPort(cfg.BindHost, strconv.Itoa(cfg.Port))
	if cfg.BindHost != "127.0.0.1" {
		fmt.Fprintf(os.Stderr, "WARNING: binding to %s, not 127.0.0.1 -- reachable by other hosts on the network, not just this machine\n", cfg.BindHost)
	}
	listener, err := net.Listen("tcp", addr)
	if err != nil {
		log.Fatalf("listen: %v", err)
	}

	port := listener.Addr().(*net.TCPAddr).Port
	// Rust reads this exact line off the child's stdout to learn the port.
	fmt.Printf("PORT=%d\n", port)

	// Storage's presigned URLs and MCP's OAuth redirect both embed the real,
	// OS-assigned port, so they can only be wired now.
	if err := app.AttachPort(context.Background(), port); err != nil {
		log.Fatalf("%v", err)
	}

	// The discovery file `amiro`'s attach-or-embed transport reads
	// (docs/tui-implementation-plan.md §2.2): a terminal launched while the
	// desktop app is open finds this and attaches instead of starting a
	// second backend against the same database.
	if err := appwiring.WriteLock(cfg.AppDataDir, port, cfg.AuthToken); err != nil {
		log.Printf("discovery lock: %v", err)
	}
	defer appwiring.RemoveLock(cfg.AppDataDir)

	uiHandler, hasUI := web.New()
	server := &http.Server{Handler: httpserver.NewWithOptions(cfg, app.Handlers, httpserver.Options{
		UI:                     uiHandler,
		BrowserAuth:            hasUI,
		LoopbackOriginWildcard: true,
	})}

	go func() {
		if err := server.Serve(listener); err != nil && err != http.ErrServerClosed {
			log.Fatalf("serve: %v", err)
		}
	}()

	// Plan §1's kill-on-abrupt-quit guard: SIGKILL of the Rust parent can't
	// be caught here (a process can't catch signals sent to a different,
	// already-dead process), so the guard is the stdin-pipe-closed watcher
	// registered above, right after ctx/stop were created. tests/suites/desktop/orphans
	// proves it without needing the real Tauri parent: a stdin pipe closing
	// is the exact, and only, OS-level signal available either way.
	<-ctx.Done()

	shutdownCtx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	if err := server.Shutdown(shutdownCtx); err != nil {
		log.Printf("shutdown: %v", err)
	}
}

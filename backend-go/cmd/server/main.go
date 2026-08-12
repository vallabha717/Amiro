// Command server is the Tauri sidecar entrypoint. It binds an OS-assigned
// loopback port, prints that port on stdout for Rust to read off the spawned
// child, and serves the API behind the shared-secret + CORS guards until it
// receives a shutdown signal.
package main

import (
	"context"
	"fmt"
	"log"
	"net"
	"net/http"
	"os"
	"os/signal"
	"strconv"
	"syscall"
	"time"

	bifrostai "betterchatbot/backend/internal/ai/bifrost"
	adminapi "betterchatbot/backend/internal/api/admin"
	agentapi "betterchatbot/backend/internal/api/agent"
	aiapi "betterchatbot/backend/internal/api/ai"
	archiveapi "betterchatbot/backend/internal/api/archive"
	bookmarkapi "betterchatbot/backend/internal/api/bookmark"
	chatapi "betterchatbot/backend/internal/api/chat"
	exportapi "betterchatbot/backend/internal/api/export"
	mcpapi "betterchatbot/backend/internal/api/mcp"
	storageapi "betterchatbot/backend/internal/api/storage"
	threadapi "betterchatbot/backend/internal/api/thread"
	userapi "betterchatbot/backend/internal/api/user"
	workflowapi "betterchatbot/backend/internal/api/workflow"
	"betterchatbot/backend/internal/auth"
	"betterchatbot/backend/internal/config"
	"betterchatbot/backend/internal/db"
	"betterchatbot/backend/internal/db/repository"
	"betterchatbot/backend/internal/httpserver"
	"betterchatbot/backend/internal/mcp"
	"betterchatbot/backend/internal/secrets"
	"betterchatbot/backend/internal/storage"
)

func main() {
	// Registered before anything else so there is no window where a SIGTERM
	// (Rust's normal kill-on-exit) or SIGINT (Ctrl+C in dev) could hit the
	// default disposition and skip graceful shutdown -- verified by
	// tests/e2e/sidecar_test.go's SIGTERM test, which caught this race when
	// the registration used to happen after the listener was already up.
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()

	cfg, err := config.Load()
	if err != nil {
		log.Fatalf("config: %v", err)
	}

	if os.Getenv("BETTERCHATBOT_AUTH_TOKEN") == "" {
		fmt.Fprintf(os.Stderr, "dev mode: no BETTERCHATBOT_AUTH_TOKEN supplied, generated one: %s\n", cfg.AuthToken)
	}

	if err := os.MkdirAll(cfg.AppDataDir, 0o700); err != nil {
		log.Fatalf("app data dir: %v", err)
	}

	gdb, err := db.Open(cfg.DatabaseDriver, cfg.DatabaseDSN)
	if err != nil {
		log.Fatalf("db: %v", err)
	}
	sqlDB, err := gdb.DB()
	if err != nil {
		log.Fatalf("db: underlying sql.DB: %v", err)
	}
	defer sqlDB.Close()

	authService := auth.NewService(gdb)

	// Desktop builds (sqlite driver) now require sign-up/login -- auto-login disabled.
	// Users must create an account and authenticate before accessing the app.
	// if cfg.DatabaseDriver == db.DialectSQLite {
	// 	_, session, err := authService.EnsureDesktopDefaultUser(context.Background())
	// 	if err != nil {
	// 		log.Fatalf("auth: desktop auto-login: %v", err)
	// 	}
	// 	fmt.Printf("SESSION_TOKEN=%s\n", session.Token)
	// 	fmt.Fprintf(os.Stderr, "dev mode: desktop auto-login session token: %s\n", session.Token)
	// }

	// Phase 3: secrets.KeyStore + bifrostai.Client wiring. desktop (sqlite
	// driver) reads provider keys from the OS keychain, a web deploy
	// (postgres driver) reads them from the environment -- same
	// sqlite=desktop/postgres=web split point Phase 2 already drew for this
	// exact package (internal/secrets's own doc comment).
	keyStore := secrets.New(cfg.DatabaseDriver == db.DialectSQLite)
	bifrostClient, err := bifrostai.NewClient(context.Background(), keyStore)
	if err != nil {
		log.Fatalf("bifrost: %v", err)
	}
	defer bifrostClient.Shutdown()

	chatRepo := repository.NewChatRepository(gdb)
	chatExportRepo := repository.NewChatExportRepository(gdb, chatRepo)
	aiHandler := aiapi.NewHandler(bifrostClient)

	// Phase 4: MCP manager wiring, over the same bifrostClient (Bifrost's
	// embedded MCP client, per Phase 0's confirmed decision). Init() dials
	// every already-configured server in the background so server startup
	// isn't blocked on slow/unreachable MCP servers -- matches the TS
	// manager's own lazy waitInitialized() pattern, which never blocks
	// process startup either. Init() itself is kicked off further down,
	// after the listener binds -- WithOAuth's redirect URL needs the
	// OS-assigned port that only becomes known then, and a remote server
	// needing OAuth may get dialed as early as Init().
	mcpRepo := repository.NewMcpRepository(gdb)
	mcpServerCustomRepo := repository.NewMcpServerCustomizationRepository(gdb)
	mcpToolCustomRepo := repository.NewMcpToolCustomizationRepository(gdb)
	mcpOAuthRepo := repository.NewMcpOAuthSessionRepository(gdb)
	mcpManager := mcp.NewManager(mcpRepo, bifrostClient)
	mcpHandler := mcpapi.NewHandler(mcpManager, mcpServerCustomRepo, mcpToolCustomRepo)

	// Phase 5: workflow node execution + api/workflow/** routes, over the
	// same bifrostClient (LLM/Tool node generation) and mcpManager (Tool
	// node mcp-tool calls) Phase 3/4 already constructed above.
	workflowRepo := repository.NewWorkflowRepository(gdb)
	workflowHandler := workflowapi.NewHandler(workflowRepo, bifrostClient, mcpManager)

	// Phase 6: the remaining api/** routes.
	agentRepo := repository.NewAgentRepository(gdb)
	archiveRepo := repository.NewArchiveRepository(gdb)
	bookmarkRepo := repository.NewBookmarkRepository(gdb)
	userRepo := repository.NewUserRepository(gdb)

	agentHandler := agentapi.NewHandler(agentRepo, bifrostClient, mcpManager, workflowRepo)

	// Phase 8: chat's mention-driven tool loading (MCP/workflow/agent) --
	// over the same mcpManager/workflowRepo/agentRepo/bifrostClient every
	// other handler above already shares.
	chatHandler := chatapi.NewHandler(
		chatRepo, chatExportRepo, bifrostClient, bifrostClient, keyStore,
		mcpManager, workflowRepo, agentRepo, mcpServerCustomRepo, mcpToolCustomRepo,
	)
	archiveHandler := archiveapi.NewHandler(archiveRepo)
	bookmarkHandler := bookmarkapi.NewHandler(bookmarkRepo)
	exportHandler := exportapi.NewHandler(chatExportRepo)
	threadHandler := threadapi.NewHandler(chatRepo)
	userHandler := userapi.NewHandler(userRepo, authService)
	adminHandler := adminapi.NewHandler(userRepo)

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

	// WithOAuth's redirect URI always targets 127.0.0.1 regardless of
	// cfg.BindHost (which may be 0.0.0.0 in dev/test only, see the
	// WARNING above) -- matching RFC 8252's loopback-redirect convention
	// for native apps, the only address a real OAuth server can be
	// expected to accept back from a desktop client whose port varies
	// every launch. Now that port is known, Init() can safely dial every
	// stored server (a remote one needing OAuth may kick off a flow that
	// needs this redirect URI as early as its first connect attempt).
	mcpManager.WithOAuth(mcpOAuthRepo, func() string {
		return "http://127.0.0.1:" + strconv.Itoa(port)
	})
	go mcpManager.Init(context.Background())

	// Constructed after the listener so LocalStorage's presigned URLs can
	// embed the real, OS-assigned port -- cfg.Port is still 0 above.
	// Backend selection uses the same sqlite=desktop / postgres=web split
	// point every other choice in this file does; the URL-signing secret
	// is persisted under the app-data dir rather than taken from
	// cfg.AuthToken, for the reason storage.LoadOrCreateSigningSecret's
	// doc comment gives.
	fileStore, err := newStorage(context.Background(), cfg, port)
	if err != nil {
		log.Fatalf("storage: %v", err)
	}
	storageHandler := storageapi.NewHandler(fileStore)

	server := &http.Server{Handler: httpserver.New(cfg, httpserver.Handlers{
		Auth:     authService,
		Admin:    adminHandler,
		AI:       aiHandler,
		Chat:     chatHandler,
		MCP:      mcpHandler,
		Workflow: workflowHandler,
		Agent:    agentHandler,
		Archive:  archiveHandler,
		Bookmark: bookmarkHandler,
		Export:   exportHandler,
		Thread:   threadHandler,
		User:     userHandler,
		Storage:  storageHandler,
	})}

	go func() {
		if err := server.Serve(listener); err != nil && err != http.ErrServerClosed {
			log.Fatalf("serve: %v", err)
		}
	}()

	// Plan §1 also calls for a kill-on-abrupt-quit guard (e.g. SIGKILL of the
	// Rust parent) -- that half lives on the Rust side, since a process can't
	// catch signals sent to a different, already-dead process; this process
	// exiting when its stdin/parent pipe closes is the Go-side complement,
	// added once the sidecar is wired into Tauri (Phase 8).
	<-ctx.Done()

	shutdownCtx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	if err := server.Shutdown(shutdownCtx); err != nil {
		log.Printf("shutdown: %v", err)
	}
}

// newStorage picks the Storage backend for this deploy target, the same
// sqlite=desktop / postgres=web split point auth's desktop auto-login and
// secrets.New already key off (plan section 3).
func newStorage(ctx context.Context, cfg config.Config, port int) (storage.Storage, error) {
	if cfg.DatabaseDriver != db.DialectSQLite {
		return storage.NewS3StorageFromEnv(ctx, cfg.S3Bucket)
	}

	secret, err := storage.LoadOrCreateSigningSecret(cfg.AppDataDir)
	if err != nil {
		return nil, err
	}
	baseURL := os.Getenv("BETTERCHATBOT_PUBLIC_BASE_URL")
	if baseURL == "" {
		baseURL = fmt.Sprintf("http://%s", net.JoinHostPort(cfg.BindHost, strconv.Itoa(port)))
	}
	return storage.NewLocalStorage(cfg.AppDataDir, secret, baseURL)
}

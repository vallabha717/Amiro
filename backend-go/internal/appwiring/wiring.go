// Package appwiring builds the object graph Amiro runs on: database,
// credentials, model client, MCP manager, repositories and every api/**
// handler, assembled in the one order their dependencies allow.
//
// # Why this is not just cmd/server's main()
//
// It was, and it was about to be copied. The Tauri sidecar is no longer the
// only thing that needs a fully-wired backend -- the terminal client starts
// one in-process when no sidecar is running, and the headless runner needs
// the same graph without a listener at all
// (docs/tui-implementation-plan.md).
//
// A second copy of this assembly would drift, and the failure mode is
// specific and already on record in this tree: internal/api/chat's toolDeps
// carries a doc comment about a repository that was threaded all the way
// from main.go into the handler and then never reached the struct literal
// that used it, so live requests ran with a nil dependency while every test
// that built the dependency by hand passed. Wiring bugs do not announce
// themselves; they present as a feature quietly not working.
//
// So: one assembly, used by every entrypoint. An entrypoint's remaining job
// is what is genuinely its own -- binding a port, drawing a terminal,
// running one prompt and exiting.
package appwiring

import (
	"context"
	"fmt"
	"net"
	"os"
	"strconv"

	"gorm.io/gorm"

	"amiro/backend/internal/agent/workspace"
	bifrostai "amiro/backend/internal/ai/bifrost"
	adminapi "amiro/backend/internal/api/admin"
	agentapi "amiro/backend/internal/api/agent"
	aiapi "amiro/backend/internal/api/ai"
	archiveapi "amiro/backend/internal/api/archive"
	bookmarkapi "amiro/backend/internal/api/bookmark"
	chatapi "amiro/backend/internal/api/chat"
	exportapi "amiro/backend/internal/api/export"
	mcpapi "amiro/backend/internal/api/mcp"
	searchapi "amiro/backend/internal/api/search"
	storageapi "amiro/backend/internal/api/storage"
	threadapi "amiro/backend/internal/api/thread"
	userapi "amiro/backend/internal/api/user"
	workflowapi "amiro/backend/internal/api/workflow"
	"amiro/backend/internal/auth"
	"amiro/backend/internal/config"
	"amiro/backend/internal/db"
	"amiro/backend/internal/db/repository"
	"amiro/backend/internal/httpserver"
	"amiro/backend/internal/mcp"
	"amiro/backend/internal/storage"
)

// App is one fully-wired backend.
//
// The fields are the pieces an entrypoint legitimately needs to reach past
// the HTTP router: Auth to sign someone in from a terminal, Chat to run a
// turn with no server at all, MCP to report what connected. Everything else
// is reachable through Handlers.
type App struct {
	Config config.Config
	DB     *gorm.DB
	Auth   *auth.Service
	MCP    *mcp.Manager
	Chat   *chatapi.Handler

	// Handlers is what httpserver.New needs. Storage is filled in by
	// AttachPort -- see its doc comment for why that one cannot be built
	// yet.
	Handlers httpserver.Handlers

	// WorkspaceRoot is the configured agent workspace, empty when the file
	// toolkit is off. Reported rather than logged: a library that logs
	// decides an entrypoint's output format for it.
	WorkspaceRoot string

	bifrost *bifrostai.Client
	closers []func()
}

// New builds everything that does not depend on a bound port.
//
// The caller owns the returned App and must Close it. ctx bounds the
// construction itself (a model client that dials on startup), not the
// App's lifetime.
func New(ctx context.Context, cfg config.Config) (*App, error) {
	if err := os.MkdirAll(cfg.AppDataDir, 0o700); err != nil {
		return nil, fmt.Errorf("app data dir: %w", err)
	}

	gdb, err := db.Open(cfg.DatabaseDriver, cfg.DatabaseDSN)
	if err != nil {
		return nil, fmt.Errorf("db: %w", err)
	}

	app := &App{Config: cfg, DB: gdb}

	sqlDB, err := gdb.DB()
	if err != nil {
		return nil, fmt.Errorf("db: underlying sql.DB: %w", err)
	}
	app.closers = append(app.closers, func() { _ = sqlDB.Close() })

	app.Auth = auth.NewService(gdb)

	providerRepo := repository.NewProviderRepository(gdb)
	bifrostClient, err := bifrostai.NewClient(ctx, providerRepo)
	if err != nil {
		app.Close()
		return nil, fmt.Errorf("bifrost: %w", err)
	}
	app.bifrost = bifrostClient
	app.closers = append(app.closers, bifrostClient.Shutdown)

	chatRepo := repository.NewChatRepository(gdb)
	chatExportRepo := repository.NewChatExportRepository(gdb, chatRepo)
	searchRepo := repository.NewSearchProviderRepository(gdb)

	// MCP: Init() dials every already-configured server in the background so
	// startup isn't blocked on a slow or unreachable one. It is kicked off
	// by AttachPort rather than here -- WithOAuth's redirect URL needs a
	// port that is not known yet, and a remote server needing OAuth may
	// start a flow as early as its first connect attempt.
	mcpRepo := repository.NewMcpRepository(gdb)
	mcpServerCustomRepo := repository.NewMcpServerCustomizationRepository(gdb)
	mcpToolCustomRepo := repository.NewMcpToolCustomizationRepository(gdb)
	app.MCP = mcp.NewManager(mcpRepo, bifrostClient)

	workflowRepo := repository.NewWorkflowRepository(gdb)
	agentRepo := repository.NewAgentRepository(gdb)
	archiveRepo := repository.NewArchiveRepository(gdb)
	bookmarkRepo := repository.NewBookmarkRepository(gdb)
	userRepo := repository.NewUserRepository(gdb)

	chatHandler := chatapi.NewHandler(
		chatRepo,
		chatExportRepo,
		bifrostClient,
		bifrostClient,
		app.MCP,
		workflowRepo,
		agentRepo,
		mcpServerCustomRepo,
		mcpToolCustomRepo,
		providerRepo,
		searchRepo,
	)

	// The file toolkit only exists when a workspace root is configured, and
	// a root that cannot be resolved is a hard startup error rather than a
	// silent downgrade to "no file tools": someone who set the variable
	// meant for the agent to have filesystem access, and finding out via a
	// mysteriously absent tool is far worse than finding out here.
	if root := cfg.WorkspaceRoot; root != "" {
		ws, wsErr := workspace.New(root)
		if wsErr != nil {
			app.Close()
			return nil, fmt.Errorf("workspace root %q: %w", root, wsErr)
		}
		chatHandler = chatHandler.WithWorkspace(ws, cfg.AppDataDir)
		app.closers = append(app.closers, chatHandler.Close)
		app.WorkspaceRoot = ws.Root()
	}
	app.Chat = chatHandler

	app.Handlers = httpserver.Handlers{
		Auth:     app.Auth,
		Admin:    adminapi.NewHandler(userRepo),
		AI:       aiapi.NewHandler(bifrostClient, providerRepo),
		Chat:     chatHandler,
		MCP:      mcpapi.NewHandler(app.MCP, mcpServerCustomRepo, mcpToolCustomRepo),
		Workflow: workflowapi.NewHandler(workflowRepo, bifrostClient, app.MCP),
		Agent:    agentapi.NewHandler(agentRepo, bifrostClient, app.MCP, workflowRepo),
		Archive:  archiveapi.NewHandler(archiveRepo),
		Bookmark: bookmarkapi.NewHandler(bookmarkRepo),
		Export:   exportapi.NewHandler(chatExportRepo),
		Thread:   threadapi.NewHandler(chatRepo),
		User:     userapi.NewHandler(userRepo, app.Auth),
		Search:   searchapi.NewHandler(searchRepo),
	}

	return app, nil
}

// AttachPort completes the wiring that could only be done once a listener
// was bound, and starts connecting MCP servers.
//
// Two things genuinely need the port, and both would be wrong if guessed:
//
//   - The OAuth redirect URI a remote MCP server is told to send the user's
//     browser back to. Always 127.0.0.1 regardless of the bind host (which
//     may be 0.0.0.0 in dev only), matching RFC 8252's loopback-redirect
//     convention for native apps -- the only address a real authorization
//     server can be expected to accept from a desktop client whose port
//     changes every launch.
//   - Local storage's presigned URLs, which embed an absolute base URL.
//
// Callers with no listener (the headless runner) skip this: they get no
// storage handler and no MCP OAuth, which is the correct capability set for
// a process nobody can redirect a browser to.
func (a *App) AttachPort(ctx context.Context, port int) error {
	a.MCP.WithOAuth(repository.NewMcpOAuthSessionRepository(a.DB), func() string {
		return "http://127.0.0.1:" + strconv.Itoa(port)
	})
	go a.MCP.Init(context.WithoutCancel(ctx))

	fileStore, err := a.newStorage(ctx, port)
	if err != nil {
		return fmt.Errorf("storage: %w", err)
	}
	a.Handlers.Storage = storageapi.NewHandler(fileStore)
	return nil
}

// LanguageServers names the languages a server was found for, so an
// entrypoint can report it at startup. Which of these exist is invisible
// from inside the app and changes what the agent can do.
func (a *App) LanguageServers() []string { return a.Chat.LanguageServers() }

// Close releases everything New started, in reverse order.
func (a *App) Close() {
	for i := len(a.closers) - 1; i >= 0; i-- {
		a.closers[i]()
	}
	a.closers = nil
}

// newStorage picks the Storage backend for this deploy target, the same
// sqlite=desktop / postgres=web split point auth's desktop auto-login and
// secrets.New already key off.
func (a *App) newStorage(ctx context.Context, port int) (storage.Storage, error) {
	if a.Config.DatabaseDriver != db.DialectSQLite {
		return storage.NewS3StorageFromEnv(ctx, a.Config.S3Bucket)
	}

	secret, err := storage.LoadOrCreateSigningSecret(a.Config.AppDataDir)
	if err != nil {
		return nil, err
	}
	baseURL := os.Getenv("AMIRO_PUBLIC_BASE_URL")
	if baseURL == "" {
		baseURL = os.Getenv("BETTERCHATBOT_PUBLIC_BASE_URL")
	}
	if baseURL == "" {
		baseURL = fmt.Sprintf("http://%s", net.JoinHostPort(a.Config.BindHost, strconv.Itoa(port)))
	}
	return storage.NewLocalStorage(a.Config.AppDataDir, secret, baseURL)
}

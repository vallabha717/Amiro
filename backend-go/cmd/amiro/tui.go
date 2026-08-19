package main

import (
	"context"
	"flag"
	"fmt"
	"path/filepath"

	tea "github.com/charmbracelet/bubbletea"
	"github.com/google/uuid"

	"amiro/backend/internal/config"
	"amiro/backend/internal/tui/app"
	tuiconfig "amiro/backend/internal/tui/config"
)

// validModes is Appendix A's --mode set, permission.ParseMode's own
// vocabulary mirrored here rather than imported -- cmd/amiro is a client
// too, same reasoning as internal/tui/session's mirrors.
var validModes = map[string]bool{"plan": true, "interactive": true, "edit": true, "auto": true}

// runTUI is the default command: resolve a transport, sign in, and run the
// chat page. workspace = cwd (or -C dir), thread = one freshly minted id
// persisted by the first message RunTurn handles (chat.RunTurn creates it
// on first use -- the client never has to ask whether it exists) unless
// --thread names one to resume instead.
func runTUI(args []string) error {
	fs := flag.NewFlagSet("amiro", flag.ContinueOnError)
	dir := fs.String("C", "", "run as though launched from dir")
	mode := fs.String("mode", "", "permission mode: plan, interactive, edit, or auto (default: interactive)")
	modelFlag := fs.String("model", "", "provider/model to use, e.g. anthropic/claude-sonnet-5 (default: the server's own default)")
	threadID := fs.String("thread", "", "resume an existing thread by id, instead of starting a new one")
	connectURL := fs.String("connect", "", "attach explicitly to the server at this URL, bypassing attach-or-embed discovery entirely (requires --token)")
	connectToken := fs.String("token", "", "the server's shared secret, required with --connect")
	serve := fs.Bool("serve", false, "also serve the web dashboard off this TUI's own embedded backend")
	serveHost := fs.String("host", "127.0.0.1", "interface --serve binds; 0.0.0.0 makes the dashboard reachable from other machines")
	servePort := fs.Int("port", 0, "port --serve binds (0 = pick a free one)")
	serveUIDir := fs.String("ui-dir", "", "serve the dashboard from this directory instead of the bundle compiled into this binary")
	var serveOrigins stringList
	fs.Var(&serveOrigins, "allow-origin", "extra origin allowed to call the API cross-origin; repeatable, --serve only")
	if err := fs.Parse(args); err != nil {
		return err
	}
	if *mode != "" && !validModes[*mode] {
		return fmt.Errorf("--mode must be one of plan, interactive, edit, auto (got %q)", *mode)
	}
	if *connectURL == "" && *connectToken != "" {
		return fmt.Errorf("--token has no effect without --connect")
	}
	// --serve serves *this* process's embedded backend. --connect means
	// this process has no backend of its own, only a client pointed at
	// someone else's -- there would be nothing here to serve, and
	// re-serving a remote backend under a second identity is not a thing
	// this flag is offering to do.
	if *serve && *connectURL != "" {
		return fmt.Errorf("--serve cannot be combined with --connect: --connect attaches to a backend this process does not own")
	}
	if !*serve {
		for _, f := range []struct {
			set  bool
			name string
		}{
			{*serveHost != "127.0.0.1", "--host"},
			{*servePort != 0, "--port"},
			{*serveUIDir != "", "--ui-dir"},
			{len(serveOrigins) > 0, "--allow-origin"},
		} {
			if f.set {
				return fmt.Errorf("%s has no effect without --serve", f.name)
			}
		}
	}

	workspaceRoot := *dir
	if workspaceRoot == "" {
		workspaceRoot = "."
	}
	workspaceRoot, err := filepath.Abs(workspaceRoot)
	if err != nil {
		return fmt.Errorf("resolving workspace root: %w", err)
	}

	// tuiCfg resolves §2.8's precedence (CLI flags → project/user
	// config.yaml → AMIRO_* env → built-in defaults) for the TUI's own
	// preferences -- distinct from cfg below, which is the sidecar's
	// bootstrap config (auth token, database DSN) and knows nothing about
	// a file on disk.
	tuiCfg := tuiconfig.Load(tuiconfig.Overrides{Mode: *mode, Model: *modelFlag}, workspaceRoot)
	if tuiCfg.DefaultMode != "" && !validModes[tuiCfg.DefaultMode] {
		return fmt.Errorf("config.yaml's defaultMode must be one of plan, interactive, edit, auto (got %q)", tuiCfg.DefaultMode)
	}

	cfg, err := config.Load()
	if err != nil {
		return fmt.Errorf("config: %w", err)
	}
	// The TUI's workspace is always the directory it was launched from --
	// authoritative over whatever AMIRO_WORKSPACE_ROOT config.Load picked
	// up, which is a desktop-app setting.  page.Chat also sends this on
	// every message (chat.TurnRequest.WorkspaceRoot), so an attached
	// server scopes file/shell tools here regardless of its own default;
	// setting it here too means an embedded server's language-server
	// watchers start against the right root from launch.
	cfg.WorkspaceRoot = workspaceRoot

	ctx := context.Background()

	var t *transport
	dashboard := ""
	if *serve {
		sc := serveConfig{
			Host:           *serveHost,
			Port:           *servePort,
			UIDir:          *serveUIDir,
			AllowedOrigins: serveOrigins,
		}
		t, dashboard, err = serveTransport(ctx, cfg, sc)
	} else {
		t, err = resolveConnection(ctx, cfg, *connectURL, *connectToken)
	}
	if err != nil {
		return err
	}
	defer t.Close()

	authed, err := resolveSession(ctx, cfg, t)
	if err != nil {
		return err
	}

	var model app.Model
	if *threadID != "" {
		detail, err := authed.GetThread(ctx, *threadID)
		if err != nil {
			return fmt.Errorf("resuming thread %s: %w", *threadID, err)
		}
		model = app.Resume(authed, detail, workspaceRoot, tuiCfg.DefaultMode)
	} else {
		model = app.New(authed, uuid.NewString(), workspaceRoot, tuiCfg.DefaultMode)
	}
	if tuiCfg.DefaultModel != nil {
		model.SetModel(tuiCfg.DefaultModel.Provider, tuiCfg.DefaultModel.Model)
	}
	if dashboard != "" {
		model.SetDashboardURL(dashboard)
	}

	program := tea.NewProgram(model, tea.WithAltScreen())
	_, err = program.Run()
	return err
}

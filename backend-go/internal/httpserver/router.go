// Package httpserver registers every route the sidecar exposes. Handler
// packages under internal/api/** get wired in here as they're ported.
package httpserver

import (
	"net/http"
	"strings"

	adminapi "amiro/backend/internal/api/admin"
	agentapi "amiro/backend/internal/api/agent"
	aiapi "amiro/backend/internal/api/ai"
	archiveapi "amiro/backend/internal/api/archive"
	authapi "amiro/backend/internal/api/auth"
	bookmarkapi "amiro/backend/internal/api/bookmark"
	chatapi "amiro/backend/internal/api/chat"
	exportapi "amiro/backend/internal/api/export"
	mcpapi "amiro/backend/internal/api/mcp"
	searchapi "amiro/backend/internal/api/search"
	skillsapi "amiro/backend/internal/api/skills"
	storageapi "amiro/backend/internal/api/storage"
	threadapi "amiro/backend/internal/api/thread"
	userapi "amiro/backend/internal/api/user"
	workflowapi "amiro/backend/internal/api/workflow"
	"amiro/backend/internal/auth"
	"amiro/backend/internal/config"
	"amiro/backend/internal/middleware"
)

// storagePathPrefix is one of two route families served outside the
// shared-secret header check -- see middleware.RequireToken's
// exemptPrefixes doc comment and internal/api/storage's Serve for why.
const storagePathPrefix = "/storage/"

// mcpOAuthCallbackPathPrefix is the other: an OAuth authorization server
// redirects the user's browser straight here, which can carry neither a
// session bearer token nor the shared-secret header.
const mcpOAuthCallbackPathPrefix = "/api/mcp/oauth/callback"

// Handlers collects every api/** handler the router wires up. Any field
// may be nil in a test that doesn't need those routes -- the real
// cmd/server/main.go constructs all of them.
//
// A struct rather than positional parameters: Phase 6 took this from four
// handlers to eleven, and a nil in the seventh slot of a call site says
// nothing about which routes it just disabled.
type Handlers struct {
	Auth     *auth.Service
	Admin    *adminapi.Handler
	AI       *aiapi.Handler
	Chat     *chatapi.Handler
	MCP      *mcpapi.Handler
	Workflow *workflowapi.Handler
	Agent    *agentapi.Handler
	Archive  *archiveapi.Handler
	Bookmark *bookmarkapi.Handler
	Export   *exportapi.Handler
	Thread   *threadapi.Handler
	User     *userapi.Handler
	Storage  *storageapi.Handler
	Search   *searchapi.Handler
	Skills   *skillsapi.Handler
}

// Options configures the route families and guards that only some
// entrypoints want. The zero Options is exactly what the Tauri sidecar has
// always had, which is why New keeps its original two-argument shape and
// delegates here.
type Options struct {
	// UI, when non-nil, serves the dashboard bundle as the last-resort
	// fallback for any request no API route matched -- `amiro serve` and
	// `amiro --serve`. The sidecar leaves it nil: its UI is loaded by the
	// Tauri webview from its own bundled frontend, not over HTTP.
	UI http.Handler

	// BrowserAuth swaps the shared-secret guard for the serve-mode one
	// (middleware.RequireTokenOrBrowser), which additionally accepts a
	// same-origin browser request. Set it only when UI is set: a page this
	// server itself delivered is the only browser request that has any
	// business skipping the header, and without a served page there is no
	// such request.
	BrowserAuth bool

	// AllowedOrigins are extra origins CORS accepts on top of
	// cfg.AllowedOrigin -- `amiro serve --allow-origin`, for a frontend
	// someone is genuinely hosting elsewhere. Empty is the normal case:
	// the served dashboard is same-origin and needs no entry here.
	AllowedOrigins []string

	// LoopbackOriginWildcard reflects any http://localhost:<port> origin.
	// True preserves the sidecar's long-standing behaviour; serve mode
	// passes false, because that blanket allowance stops being harmless
	// the moment the listener leaves loopback. See middleware.CORS.
	LoopbackOriginWildcard bool

	// RateLimit, when non-nil, throttles the unauthenticated auth routes
	// per client IP. cmd/amiro installs it for a non-loopback bind only.
	RateLimit *middleware.RateLimitConfig
}

// New wires every route the sidecar exposes.
func New(cfg config.Config, h Handlers) http.Handler {
	return NewWithOptions(cfg, h, Options{LoopbackOriginWildcard: true})
}

// NewWithOptions is New with the serve-mode knobs exposed.
func NewWithOptions(cfg config.Config, h Handlers, opts Options) http.Handler {
	mux := http.NewServeMux()

	// Path prefixes exempt from the shared-secret header, populated only
	// if the routes needing that exemption are actually registered below.
	var tokenExemptPrefixes []string

	mux.HandleFunc("GET /health", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		w.Write([]byte(`{"status":"ok"}`))
	})

	if h.Auth != nil {
		mux.HandleFunc("GET /api/auth/status", authapi.Status(h.Auth))
		mux.HandleFunc("POST /api/auth/register", authapi.Register(h.Auth))
		mux.HandleFunc("POST /api/auth/login", authapi.Login(h.Auth))
		mux.Handle("POST /api/auth/logout", auth.RequireSession(h.Auth)(authapi.Logout(h.Auth)))
		mux.Handle("GET /api/auth/session", auth.RequireSession(h.Auth)(http.HandlerFunc(authapi.Me)))
	}

	if h.Chat != nil {
		mux.HandleFunc("GET /api/chat/models", h.Chat.Models)
		if h.Auth != nil {
			session := auth.RequireSession(h.Auth)
			mux.Handle("POST /api/chat", session(http.HandlerFunc(h.Chat.Chat)))
			mux.Handle("POST /api/chat/title", session(http.HandlerFunc(h.Chat.Title)))
			mux.Handle("POST /api/chat/temporary", session(http.HandlerFunc(h.Chat.Temporary)))
			mux.Handle("POST /api/chat/export", session(http.HandlerFunc(h.Chat.Export)))
			mux.Handle("POST /api/chat/openai-realtime", session(http.HandlerFunc(h.Chat.OpenAIRealtime)))
		}
	}

	if h.MCP != nil && h.Auth != nil {
		session := auth.RequireSession(h.Auth)
		mux.Handle("POST /api/mcp", session(http.HandlerFunc(h.MCP.Save)))
		mux.Handle("GET /api/mcp/list", session(http.HandlerFunc(h.MCP.List)))
		// Every id-scoped operation nests under the literal "servers" segment
		// (not the TS route's bare /api/mcp/[id]) so its {id} wildcard can
		// never collide with the *-customizations routes' own multi-segment
		// literal-then-wildcard shape below. Next.js's file-based router
		// disambiguates siblings like [id]/ and server-customizations/ by
		// directory structure with no notion of "ambiguous" at all; Go's
		// net/http.ServeMux statically rejects registering two patterns where
		// neither is more specific than the other at every differing
		// position, which /api/mcp/{id}/refresh vs.
		// /api/mcp/server-customizations/{server} triggers (wildcard-then-
		// literal vs. literal-then-wildcard). This is the one route shape in
		// Phase 4 that isn't byte-identical to the TS path -- worth knowing
		// for Phase 7's eventual frontend rewire.
		mux.Handle("GET /api/mcp/servers/{id}", session(http.HandlerFunc(h.MCP.Get)))
		mux.Handle("DELETE /api/mcp/servers/{id}", session(http.HandlerFunc(h.MCP.Delete)))
		mux.Handle("POST /api/mcp/servers/{id}/refresh", session(http.HandlerFunc(h.MCP.Refresh)))
		mux.Handle("POST /api/mcp/servers/{id}/share", session(http.HandlerFunc(h.MCP.Share)))
		mux.Handle("POST /api/mcp/servers/{id}/tools/{tool}/call", session(http.HandlerFunc(h.MCP.CallTool)))
		mux.Handle("POST /api/mcp/servers/{id}/oauth/authorize", session(http.HandlerFunc(h.MCP.Authorize)))
		// Not session-wrapped and exempted from the shared-secret header
		// below (mcpOAuthCallbackPathPrefix): the authorization server
		// redirects the user's own browser here directly, which can carry
		// neither a session bearer token nor the shared-secret header --
		// same reasoning as /storage/{token}'s exemption, see
		// RequireToken's doc comment.
		mux.HandleFunc("GET /api/mcp/oauth/callback", h.MCP.OAuthCallback)
		tokenExemptPrefixes = append(tokenExemptPrefixes, mcpOAuthCallbackPathPrefix)
		mux.Handle("GET /api/mcp/server-customizations/{server}", session(http.HandlerFunc(h.MCP.GetServerCustomization)))
		mux.Handle("POST /api/mcp/server-customizations/{server}", session(http.HandlerFunc(h.MCP.SaveServerCustomization)))
		mux.Handle("DELETE /api/mcp/server-customizations/{server}", session(http.HandlerFunc(h.MCP.DeleteServerCustomization)))
		mux.Handle("GET /api/mcp/tool-customizations/{server}", session(http.HandlerFunc(h.MCP.ListToolCustomizations)))
		mux.Handle("GET /api/mcp/tool-customizations/{server}/{tool}", session(http.HandlerFunc(h.MCP.GetToolCustomization)))
		mux.Handle("POST /api/mcp/tool-customizations/{server}/{tool}", session(http.HandlerFunc(h.MCP.SaveToolCustomization)))
		mux.Handle("DELETE /api/mcp/tool-customizations/{server}/{tool}", session(http.HandlerFunc(h.MCP.DeleteToolCustomization)))
	}

	if h.AI != nil && h.Auth != nil {
		session := auth.RequireSession(h.Auth)
		mux.Handle("POST /api/ai/generate-object", session(http.HandlerFunc(h.AI.GenerateObject)))
		mux.Handle("POST /api/ai/generate-example-tool-schema", session(http.HandlerFunc(h.AI.GenerateExampleToolSchema)))
		mux.Handle("GET /api/ai/providers", session(http.HandlerFunc(h.AI.GetProviderStatuses)))
		mux.Handle("POST /api/ai/providers", session(http.HandlerFunc(h.AI.SetProviderKey)))
		mux.Handle("DELETE /api/ai/providers/{id}", session(http.HandlerFunc(h.AI.DeleteProviderConfig)))
		// "models" is a literal where the sibling patterns take an {id}
		// wildcard, but only for POST, and ServeMux orders literal-over-
		// wildcard fine -- the ambiguity that forced /api/mcp/servers/{id}
		// above needs wildcard-then-literal on *both* sides to trigger.
		mux.Handle("POST /api/ai/providers/models", session(http.HandlerFunc(h.AI.FetchProviderModels)))
		mux.Handle("POST /api/ai/providers/{id}/sync-models", session(http.HandlerFunc(h.AI.SyncProviderModels)))
		mux.Handle("POST /api/ai/providers/{id}/test", session(http.HandlerFunc(h.AI.TestProviderModel)))
	}

	if h.Search != nil && h.Auth != nil {
		session := auth.RequireSession(h.Auth)
		// Active is deliberately reachable by any signed-in user, not just an
		// admin -- see GetActive's own comment. Every other route below it
		// reads or writes API keys and stays admin-gated inside the handler.
		mux.Handle("GET /api/search/active", session(http.HandlerFunc(h.Search.GetActive)))
		mux.Handle("GET /api/search/catalog", session(http.HandlerFunc(h.Search.GetCatalog)))
		mux.Handle("GET /api/search/providers", session(http.HandlerFunc(h.Search.GetStatuses)))
		mux.Handle("POST /api/search/providers", session(http.HandlerFunc(h.Search.SetConfig)))
		mux.Handle("DELETE /api/search/providers/{id}", session(http.HandlerFunc(h.Search.DeleteConfig)))
		mux.Handle("POST /api/search/providers/{id}/test", session(http.HandlerFunc(h.Search.TestProvider)))
		mux.Handle("POST /api/search/providers/{id}/activate", session(http.HandlerFunc(h.Search.Activate)))
	}

	if h.Workflow != nil && h.Auth != nil {
		session := auth.RequireSession(h.Auth)
		mux.Handle("GET /api/workflow", session(http.HandlerFunc(h.Workflow.List)))
		mux.Handle("POST /api/workflow", session(http.HandlerFunc(h.Workflow.Save)))
		mux.Handle("GET /api/workflow/tools", session(http.HandlerFunc(h.Workflow.ExecuteAbility)))
		mux.Handle("GET /api/workflow/{id}", session(http.HandlerFunc(h.Workflow.Get)))
		mux.Handle("PUT /api/workflow/{id}", session(http.HandlerFunc(h.Workflow.Update)))
		mux.Handle("DELETE /api/workflow/{id}", session(http.HandlerFunc(h.Workflow.Delete)))
		mux.Handle("GET /api/workflow/{id}/structure", session(http.HandlerFunc(h.Workflow.GetStructure)))
		mux.Handle("POST /api/workflow/{id}/structure", session(http.HandlerFunc(h.Workflow.SaveStructure)))
		mux.Handle("POST /api/workflow/{id}/execute", session(http.HandlerFunc(h.Workflow.Execute)))
	}

	if h.Agent != nil && h.Auth != nil {
		session := auth.RequireSession(h.Auth)
		mux.Handle("GET /api/agent", session(http.HandlerFunc(h.Agent.List)))
		mux.Handle("POST /api/agent", session(http.HandlerFunc(h.Agent.Create)))
		// POST /api/agent/ai and GET|PUT|DELETE /api/agent/{id} coexist
		// because ServeMux only rejects same-method patterns it can't
		// order, and no {id} pattern is registered for POST.
		mux.Handle("POST /api/agent/ai", session(http.HandlerFunc(h.Agent.Generate)))
		mux.Handle("GET /api/agent/{id}", session(http.HandlerFunc(h.Agent.Get)))
		mux.Handle("PUT /api/agent/{id}", session(http.HandlerFunc(h.Agent.Update)))
		mux.Handle("DELETE /api/agent/{id}", session(http.HandlerFunc(h.Agent.Delete)))
	}

	if h.Archive != nil && h.Auth != nil {
		session := auth.RequireSession(h.Auth)
		mux.Handle("GET /api/archive", session(http.HandlerFunc(h.Archive.List)))
		mux.Handle("POST /api/archive", session(http.HandlerFunc(h.Archive.Create)))
		mux.Handle("GET /api/archive/{id}", session(http.HandlerFunc(h.Archive.Get)))
		mux.Handle("PUT /api/archive/{id}", session(http.HandlerFunc(h.Archive.Update)))
		mux.Handle("DELETE /api/archive/{id}", session(http.HandlerFunc(h.Archive.Delete)))
		mux.Handle("GET /api/archive/{id}/items", session(http.HandlerFunc(h.Archive.ListItems)))
		mux.Handle("POST /api/archive/{id}/items", session(http.HandlerFunc(h.Archive.AddItem)))
		mux.Handle("DELETE /api/archive/{id}/items/{itemId}", session(http.HandlerFunc(h.Archive.RemoveItem)))
	}

	if h.Bookmark != nil && h.Auth != nil {
		session := auth.RequireSession(h.Auth)
		mux.Handle("POST /api/bookmark", session(http.HandlerFunc(h.Bookmark.Create)))
		mux.Handle("DELETE /api/bookmark", session(http.HandlerFunc(h.Bookmark.Delete)))
	}

	if h.Export != nil && h.Auth != nil {
		session := auth.RequireSession(h.Auth)
		optional := auth.OptionalSession(h.Auth)
		mux.Handle("GET /api/export", session(http.HandlerFunc(h.Export.List)))
		// Reading a shared export and its comments takes an optional
		// session, not a required one -- both are public share-link
		// surfaces in the TS app (see internal/api/export's doc comment).
		mux.Handle("GET /api/export/{id}", optional(http.HandlerFunc(h.Export.Get)))
		mux.Handle("DELETE /api/export/{id}", session(http.HandlerFunc(h.Export.Delete)))
		mux.Handle("GET /api/export/{id}/comments", optional(http.HandlerFunc(h.Export.ListComments)))
		mux.Handle("POST /api/export/{id}/comments", session(http.HandlerFunc(h.Export.CreateComment)))
		mux.Handle("DELETE /api/export/{id}/comments/{commentId}", session(http.HandlerFunc(h.Export.DeleteComment)))
	}

	if h.Thread != nil && h.Auth != nil {
		session := auth.RequireSession(h.Auth)
		mux.Handle("GET /api/thread", session(http.HandlerFunc(h.Thread.List)))
		mux.Handle("DELETE /api/thread", session(http.HandlerFunc(h.Thread.DeleteAll)))
		mux.Handle("GET /api/thread/{id}", session(http.HandlerFunc(h.Thread.Get)))
		mux.Handle("PUT /api/thread/{id}", session(http.HandlerFunc(h.Thread.Update)))
		mux.Handle("DELETE /api/thread/{id}", session(http.HandlerFunc(h.Thread.Delete)))
		mux.Handle("DELETE /api/thread/messages/{id}", session(http.HandlerFunc(h.Thread.DeleteMessage)))
		mux.Handle("POST /api/thread/messages/{id}/truncate", session(http.HandlerFunc(h.Thread.TruncateAfter)))
	}

	if h.User != nil && h.Auth != nil {
		session := auth.RequireSession(h.Auth)
		mux.Handle("GET /api/user/details", session(http.HandlerFunc(h.User.Details)))
		mux.Handle("PUT /api/user/details", session(http.HandlerFunc(h.User.UpdateDetails)))
		mux.Handle("GET /api/user/details/{id}", session(http.HandlerFunc(h.User.DetailsByID)))
		mux.Handle("GET /api/user/stats", session(http.HandlerFunc(h.User.Stats)))
		mux.Handle("PUT /api/user/password", session(http.HandlerFunc(h.User.UpdatePassword)))
		mux.Handle("GET /api/user/auth-methods", session(http.HandlerFunc(h.User.AuthMethods)))
		mux.Handle("GET /api/user/preferences", session(http.HandlerFunc(h.User.GetPreferences)))
		mux.Handle("PUT /api/user/preferences", session(http.HandlerFunc(h.User.UpdatePreferences)))
	}

	if h.Admin != nil && h.Auth != nil {
		session := auth.RequireSession(h.Auth)
		mux.Handle("GET /api/admin/users", session(http.HandlerFunc(h.Admin.List)))
		mux.Handle("GET /api/admin/users/{id}", session(http.HandlerFunc(h.Admin.Get)))
		mux.Handle("GET /api/admin/users/{id}/stats", session(http.HandlerFunc(h.Admin.GetStats)))
		mux.Handle("PUT /api/admin/users/{id}/role", session(http.HandlerFunc(h.Admin.UpdateRole)))
		mux.Handle("PUT /api/admin/users/{id}/ban", session(http.HandlerFunc(h.Admin.UpdateBanStatus)))
		mux.Handle("DELETE /api/admin/users/{id}", session(http.HandlerFunc(h.Admin.Delete)))
	}

	if h.Skills != nil && h.Auth != nil {
		session := auth.RequireSession(h.Auth)
		mux.Handle("GET /api/skills", session(http.HandlerFunc(h.Skills.List)))
		mux.Handle("GET /api/skills/items/{name}", session(http.HandlerFunc(h.Skills.Get)))
	}

	if h.Storage != nil {
		if h.Auth != nil {
			session := auth.RequireSession(h.Auth)
			mux.Handle("POST /api/storage/upload", session(http.HandlerFunc(h.Storage.Upload)))
			mux.Handle("POST /api/storage/upload-url", session(http.HandlerFunc(h.Storage.UploadURL)))
			mux.Handle("POST /api/storage/ingest", session(http.HandlerFunc(h.Storage.Ingest)))
		}
		// Only registered when the configured backend actually serves its
		// own presigned URLs (LocalStorage). A web deploy's presigned URLs
		// point at S3 directly, so these would never be called -- and not
		// registering them keeps the RequireToken exemption below from
		// covering any live route there.
		if h.Storage.TokenResolver() {
			mux.HandleFunc("GET /storage/{token}", h.Storage.Serve)
			mux.HandleFunc("PUT /storage/{token}", h.Storage.ReceiveUpload)
			tokenExemptPrefixes = append(tokenExemptPrefixes, storagePathPrefix)
		}
	}

	// The dashboard is the last-resort fallback: registered on the bare
	// "/" pattern, which ServeMux only reaches after every method+path
	// API pattern has failed to match. apiAware wraps it so that an
	// unmatched /api or /storage path answers as an API would (404 JSON)
	// rather than handing back the SPA shell -- a mistyped route should
	// not look like a page that briefly loaded.
	if opts.UI != nil {
		mux.Handle("/", apiAware(opts.UI))
	}

	origins := append([]string{cfg.AllowedOrigin}, opts.AllowedOrigins...)

	var handler http.Handler = mux
	if opts.BrowserAuth {
		handler = middleware.RequireTokenOrBrowser(cfg.AuthToken, origins, tokenExemptPrefixes...)(handler)
	} else {
		handler = middleware.RequireToken(cfg.AuthToken, tokenExemptPrefixes...)(handler)
	}
	if opts.RateLimit != nil {
		// Outside the auth guard: refusing a flood of login attempts is
		// cheaper the earlier it happens, and a caller holding a valid
		// shared secret has no more business brute-forcing a password
		// than anyone else.
		handler = middleware.RateLimit(*opts.RateLimit)(handler)
	}
	handler = middleware.CORS(origins, opts.LoopbackOriginWildcard)(handler)
	return handler
}

// apiPrefixes are the path families that must never fall through to the
// dashboard. Both are served by real routes above; a request landing here
// under one of these prefixes matched none of them.
var apiPrefixes = []string{"/api/", "/storage/", "/health"}

func apiAware(ui http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		for _, prefix := range apiPrefixes {
			if strings.HasPrefix(r.URL.Path, prefix) {
				w.Header().Set("Content-Type", "application/json")
				w.WriteHeader(http.StatusNotFound)
				_, _ = w.Write([]byte(`{"error":"not found"}`))
				return
			}
		}
		ui.ServeHTTP(w, r)
	})
}

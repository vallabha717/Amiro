package chat

import (
	"amiro/backend/internal/agent/lsp"
	"amiro/backend/internal/agent/memory"
	"amiro/backend/internal/agent/permission"
	"amiro/backend/internal/agent/workspace"
	"context"
	"encoding/json"

	bifrostai "amiro/backend/internal/ai/bifrost"
	"amiro/backend/internal/ai/tools"
	"amiro/backend/internal/ai/workflow/executor"
	"amiro/backend/internal/db/repository"
	"amiro/backend/internal/mcp"
	"amiro/backend/internal/skills"
	"amiro/backend/internal/storage"
)

// Engine is the subset of *bifrostai.Client the chat handlers call,
// narrowed to an interface so handler tests can substitute a fake stream
// source instead of a real Bifrost client + real provider keys. Stream
// backs title/temporary (still text-only); StreamStep backs Chat's
// multi-step tool-calling loop (tool_loop.go) over a real network stream,
// calling onTextDelta as each fragment arrives.
type Engine interface {
	Stream(ctx context.Context, resolved bifrostai.ResolvedModel, system string, messages []bifrostai.Message) (<-chan bifrostai.Chunk, error)
	StreamStep(ctx context.Context, resolved bifrostai.ResolvedModel, system string, messages []bifrostai.Message, toolSpecs []bifrostai.ToolSpec, hooks bifrostai.StepHooks) (*bifrostai.StepResult, error)
}

// MCPTools is the subset of *mcp.Manager the mention-driven tool loading
// (mentions.go) needs: server+tool listing to resolve mentions/
// allowedMcpServers, and calling one tool.
type MCPTools interface {
	List(ctx context.Context, userID string) ([]mcp.ServerInfo, error)
	CallTool(ctx context.Context, id, toolName string, args json.RawMessage) bifrostai.MCPToolCallResult
}

// WorkflowTools is the subset of *repository.WorkflowRepository a
// workflow-as-tool @-mention needs: its parameter schema, and (at call
// time) the node graph to actually run.
type WorkflowTools interface {
	SelectToolByIDs(ctx context.Context, ids []string) ([]repository.WorkflowToolInfo, error)
	SelectStructureByID(ctx context.Context, id string, ignoreNote bool) (*repository.WorkflowStructure, error)
}

// Handler holds every dependency the api/chat/** routes need. Constructed
// once in httpserver.New and its methods registered as
// net/http.HandlerFunc values, the same wiring shape internal/api/auth
// already uses.
type Handler struct {
	chats           *repository.ChatRepository
	exports         *repository.ChatExportRepository
	engine          Engine
	workflowEngine  executor.Engine // same underlying *bifrostai.Client as engine, under the wider interface workflow-as-tool execution needs
	mcp             MCPTools
	workflows       WorkflowTools
	mcpServerCustom *repository.McpServerCustomizationRepository
	mcpToolCustom   *repository.McpToolCustomizationRepository
	providerRepo    *repository.ProviderRepository
	searchRepo      *repository.SearchProviderRepository

	// workspace roots the file toolkit. Nil means no workspace was
	// configured, which omits the file tools entirely -- set via
	// WithWorkspace rather than the constructor so the many existing
	// NewHandler call sites (and tests) keep working unchanged.
	workspace *workspace.Workspace

	// grants remembers per-thread "always allow" answers. It lives on the
	// handler rather than inside a request because the approval round trip
	// spans two requests: the turn that asks ends, and a later one resumes.
	grants *permission.Store

	// todos holds each thread's plan. On the handler for the same reason as
	// grants -- a plan that reset every request would only ever hold what
	// the current turn wrote, which is not a plan.
	todos *tools.TodoStore

	// notes are the workspace's durable memories, outliving every
	// conversation in it. Nil when no workspace or no data directory was
	// configured, which omits both the memory tools and the system-prompt
	// injection -- never one without the other.
	notes *memory.Store

	// lsp holds language servers for this workspace, started lazily and
	// shared across requests. Nil when none is installed for a language the
	// workspace uses; that is the common case and the `lsp` tool is then
	// never offered.
	lsp *lsp.Pool

	// skills discovers and resolves Agent Skills for prompt disclosure and activation.
	skills *skills.Service

	// trust backs the workspace-trust gate
	// (docs/coding-agent-parity/01-workspace-trust-and-rules.md). Nil means
	// no trust repository was wired -- runner.go then leaves every
	// permission.Engine at its New default (trusted), which is the same
	// "optional dependency degrades rather than panics" contract every
	// other nil field on this struct already has.
	trust *repository.WorkspaceTrustRepository

	// checkpoints and checkpointBlobs back /rewind
	// (docs/coding-agent-parity/02-checkpoints-and-rewind.md). Both nil
	// until WithCheckpoints is called -- appwiring.App.AttachPort, since
	// the blob store can't be built until a port is bound (see
	// appwiring.App.newStorage). runner.go degrades to capturing nothing
	// when either is nil, the same contract every other optional
	// dependency on this struct already has.
	checkpoints     *repository.CheckpointFileRepository
	checkpointBlobs storage.Storage

	// sandboxNetworkAllow is internal/config.Config.SandboxNetworkAllow,
	// carried onto the handler the same way workspace/trust are: set via a
	// chained method so the existing NewHandler call sites and tests keep
	// working unchanged. Nil (the default) denies network to every
	// sandboxed shell command -- see internal/agent/sandbox.NetworkAllowed.
	sandboxNetworkAllow []string

	// githubToken and githubAPIBase back create_pr
	// (docs/coding-agent-parity/04-git-remote-operations.md). githubToken
	// nil (the default) means create_pr refuses before any HTTP call --
	// the same "optional dependency degrades rather than panics" contract
	// every other nil field on this handler already has.
	githubToken   func(ctx context.Context) (string, bool, error)
	githubAPIBase string

	// backgroundJobs is nil unless WithBackgroundJobs was called
	// (appwiring.App.New, once the repository exists). Nil is the same
	// "optional dependency degrades rather than panics" contract every
	// other field on this struct has: RunTurn simply never looks up or
	// updates a job for the thread, which is exactly right for every
	// caller that isn't running a background job's thread.
	backgroundJobs *repository.BackgroundJobRepository
}

// WithBackgroundJobs binds the durable job repository to this handler, so
// RunTurn can recognize -- for any caller, worker goroutine or ordinary
// approval resubmission alike -- that a thread it just ran belongs to a
// background job, and keep that job's row in sync
// (docs/coding-agent-parity/05-background-agent-runs.md).
func (h *Handler) WithBackgroundJobs(repo *repository.BackgroundJobRepository) *Handler {
	h.backgroundJobs = repo
	return h
}

// WithSandboxNetworkAllow binds the project's shell-network allow-list
// (docs/coding-agent-parity/03-sandboxed-execution.md) to this handler.
func (h *Handler) WithSandboxNetworkAllow(allow []string) *Handler {
	h.sandboxNetworkAllow = allow
	return h
}

// WithGitHub binds create_pr's token lookup and API base to this handler.
// tokenFn is nil-safe to omit entirely -- see the githubToken field's doc
// comment.
func (h *Handler) WithGitHub(tokenFn func(ctx context.Context) (string, bool, error), apiBase string) *Handler {
	h.githubToken = tokenFn
	h.githubAPIBase = apiBase
	return h
}

// WithCheckpoints binds the checkpoint index and blob store to this
// handler. A chained method for the same reason WithWorkspaceTrust is: it
// keeps the many existing NewHandler call sites and tests working
// unchanged, and (unlike those) the blob store genuinely cannot exist at
// construction time -- see the struct field's doc comment.
func (h *Handler) WithCheckpoints(repo *repository.CheckpointFileRepository, blobs storage.Storage) *Handler {
	h.checkpoints = repo
	h.checkpointBlobs = blobs
	return h
}

// Grants exposes the per-thread grant/lock store so the checkpoint restore
// route (internal/api/checkpoint) can take the same thread's write-lock a
// live turn holds while it runs -- see runner.go's sess.RLock/RUnlock and
// permission.Session.writeMu's doc comment for why they must be the same
// underlying Session.
func (h *Handler) Grants() *permission.Store { return h.grants }

// WithWorkspaceTrust binds the trust-grant repository to this handler. Set
// via a chained method rather than the constructor for the same reason as
// WithWorkspace and WithSkills: the many existing NewHandler call sites and
// tests keep working unchanged.
func (h *Handler) WithWorkspaceTrust(trust *repository.WorkspaceTrustRepository) *Handler {
	h.trust = trust
	return h
}

// WithSkills binds the discovery service to this handler.
func (h *Handler) WithSkills(s *skills.Service) *Handler {
	h.skills = s
	return h
}

// WithWorkspace scopes this handler's file tools to ws, and brings up the
// two capabilities that only make sense with one: durable notes about the
// workspace, and language servers for the languages it contains.
//
// Both are best-effort. A memory store that cannot open its file and a
// machine with no language server installed are ordinary situations, not
// errors -- the corresponding tools are simply not offered, which is the
// same contract tools.Deps already states for every other dependency.
// Failing the whole file toolkit because a language server is missing
// would be a much worse trade than losing one accelerator.
func (h *Handler) WithWorkspace(ws *workspace.Workspace, dataDir string) *Handler {
	h.workspace = ws
	if ws == nil {
		return h
	}
	if store, err := memory.Open(dataDir, ws.Root()); err == nil {
		h.notes = store
	}
	h.lsp = lsp.NewPool(ws.Root())
	return h
}

// Notes exposes the workspace memory store, for the system prompt.
func (h *Handler) Notes() *memory.Store { return h.notes }

// LanguageServers names the languages a server was found for, so startup
// can log it. Which of these exist is invisible from inside the app and
// changes what the agent can do, so it is worth one line at boot.
func (h *Handler) LanguageServers() []string { return h.lsp.Languages() }

// Close releases anything the handler started, notably language server
// processes. Called on server shutdown; without it a killed sidecar leaves
// gopls running against a workspace nobody is looking at.
func (h *Handler) Close() {
	h.lsp.Close()
}

func NewHandler(
	chats *repository.ChatRepository,
	exports *repository.ChatExportRepository,
	engine Engine,
	workflowEngine executor.Engine,
	mcpTools MCPTools,
	workflows WorkflowTools,
	mcpServerCustom *repository.McpServerCustomizationRepository,
	mcpToolCustom *repository.McpToolCustomizationRepository,
	providerRepo *repository.ProviderRepository,
	searchRepo *repository.SearchProviderRepository,
) *Handler {
	return &Handler{
		chats:           chats,
		exports:         exports,
		engine:          engine,
		workflowEngine:  workflowEngine,
		mcp:             mcpTools,
		workflows:       workflows,
		mcpServerCustom: mcpServerCustom,
		mcpToolCustom:   mcpToolCustom,
		providerRepo:    providerRepo,
		searchRepo:      searchRepo,
		grants:          permission.NewStore(),
		todos:           tools.NewTodoStore(),
	}
}

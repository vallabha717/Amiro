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

// AgentTools is the subset of *repository.AgentRepository an agent
// @-mention needs: the agent's own instructions (systemPrompt/role/
// mentions), gated by the same ownership/visibility rule agent CRUD uses.
type AgentTools interface {
	SelectByID(ctx context.Context, id, userID string) (*repository.AgentWithMeta, error)
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
	agents          AgentTools
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
	agents AgentTools,
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
		agents:          agents,
		mcpServerCustom: mcpServerCustom,
		mcpToolCustom:   mcpToolCustom,
		providerRepo:    providerRepo,
		searchRepo:      searchRepo,
		grants:          permission.NewStore(),
		todos:           tools.NewTodoStore(),
	}
}

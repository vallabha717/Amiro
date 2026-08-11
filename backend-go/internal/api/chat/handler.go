package chat

import (
	"context"
	"encoding/json"

	bifrostai "betterchatbot/backend/internal/ai/bifrost"
	"betterchatbot/backend/internal/ai/workflow/executor"
	"betterchatbot/backend/internal/db/repository"
	"betterchatbot/backend/internal/mcp"
	"betterchatbot/backend/internal/secrets"
)

// Engine is the subset of *bifrostai.Client the chat handlers call,
// narrowed to an interface so handler tests can substitute a fake stream
// source instead of a real Bifrost client + real provider keys. Stream
// backs title/temporary (still text-only); StreamStep backs Chat's
// multi-step tool-calling loop (tool_loop.go) over a real network stream,
// calling onTextDelta as each fragment arrives.
type Engine interface {
	Stream(ctx context.Context, resolved bifrostai.ResolvedModel, system string, messages []bifrostai.Message) (<-chan bifrostai.Chunk, error)
	StreamStep(ctx context.Context, resolved bifrostai.ResolvedModel, system string, messages []bifrostai.Message, toolSpecs []bifrostai.ToolSpec, onTextDelta func(string)) (*bifrostai.StepResult, error)
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
	secrets         secrets.KeyStore
	mcp             MCPTools
	workflows       WorkflowTools
	agents          AgentTools
	mcpServerCustom *repository.McpServerCustomizationRepository
	mcpToolCustom   *repository.McpToolCustomizationRepository
}

func NewHandler(
	chats *repository.ChatRepository,
	exports *repository.ChatExportRepository,
	engine Engine,
	workflowEngine executor.Engine,
	store secrets.KeyStore,
	mcpTools MCPTools,
	workflows WorkflowTools,
	agents AgentTools,
	mcpServerCustom *repository.McpServerCustomizationRepository,
	mcpToolCustom *repository.McpToolCustomizationRepository,
) *Handler {
	return &Handler{
		chats: chats, exports: exports, engine: engine, workflowEngine: workflowEngine, secrets: store,
		mcp: mcpTools, workflows: workflows, agents: agents,
		mcpServerCustom: mcpServerCustom, mcpToolCustom: mcpToolCustom,
	}
}

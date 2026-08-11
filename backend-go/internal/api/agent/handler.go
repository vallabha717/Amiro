// Package agent ports src/app/api/agent/**: agent CRUD plus the
// LLM-backed agent-generation endpoint.
//
// Permission model: any authenticated user may create an agent and manage
// their own, gated purely by AgentRepository.CheckAccess's
// ownership/visibility rules. The TS routes layer an additional
// canCreateAgent/canEditAgent/canDeleteAgent role-tier gate on top
// ("Only editors and admins can edit agents"), which is not ported for the
// same reason mcp.CanManage's and internal/api/workflow's doc comments
// already give: this backend's auth model only ever assigns "user"/"admin"
// (Phase 2), and the desktop auto-login user is always "user" -- applying
// the TS tier literally would leave the single desktop user unable to
// create an agent at all, a regression against this rewrite's own primary
// target.
package agent

import (
	"context"
	"encoding/json"
	"net/http"
	"time"

	bifrostai "betterchatbot/backend/internal/ai/bifrost"
	"betterchatbot/backend/internal/api/httpjson"
	"betterchatbot/backend/internal/db/models"
	"betterchatbot/backend/internal/db/repository"
	"betterchatbot/backend/internal/mcp"
)

// Engine is the subset of *bifrostai.Client the generation route calls,
// narrowed so handler tests can substitute a fake -- the same pattern
// internal/api/chat.Engine and executor.Engine already use.
type Engine interface {
	GenerateObject(ctx context.Context, resolved bifrostai.ResolvedModel, system string, messages []bifrostai.Message, schema json.RawMessage) (json.RawMessage, *bifrostai.Usage, error)
}

// MCPTools is the subset of *mcp.Manager the generation route calls: it
// needs the names of every tool the user could bind to an agent.
type MCPTools interface {
	List(ctx context.Context, userID string) ([]mcp.ServerInfo, error)
}

// WorkflowTools is the subset of *repository.WorkflowRepository the
// generation route calls -- published workflows are selectable as agent
// tools the same way MCP tools are.
type WorkflowTools interface {
	SelectExecuteAbility(ctx context.Context, userID string) ([]repository.WorkflowWithOwner, error)
}

type Handler struct {
	agents    *repository.AgentRepository
	engine    Engine
	mcp       MCPTools
	workflows WorkflowTools
}

func NewHandler(agents *repository.AgentRepository, engine Engine, mcpTools MCPTools, workflows WorkflowTools) *Handler {
	return &Handler{agents: agents, engine: engine, mcp: mcpTools, workflows: workflows}
}

// agentResponse ports AgentSummary + Agent (types/agent.ts:57,71). The
// list route omits Instructions (the TS select does too), which is why the
// field is omitempty rather than always present.
type agentResponse struct {
	ID           string          `json:"id"`
	Name         string          `json:"name"`
	Description  *string         `json:"description,omitempty"`
	Icon         json.RawMessage `json:"icon,omitempty"`
	UserID       string          `json:"userId"`
	Instructions json.RawMessage `json:"instructions,omitempty"`
	Visibility   string          `json:"visibility"`
	CreatedAt    time.Time       `json:"createdAt"`
	UpdatedAt    time.Time       `json:"updatedAt"`
	UserName     string          `json:"userName,omitempty"`
	UserAvatar   *string         `json:"userAvatar,omitempty"`
	IsBookmarked bool            `json:"isBookmarked"`
}

func toAgentResponse(a models.Agent) agentResponse {
	return agentResponse{
		ID: a.ID, Name: a.Name, Description: a.Description,
		Icon: json.RawMessage(a.Icon), UserID: a.UserID,
		Instructions: instructionsOrEmpty(a.Instructions),
		Visibility:   a.Visibility, CreatedAt: a.CreatedAt, UpdatedAt: a.UpdatedAt,
	}
}

func toAgentWithMetaResponse(a repository.AgentWithMeta, withInstructions bool) agentResponse {
	out := toAgentResponse(a.Agent)
	out.UserName = a.UserName
	out.UserAvatar = a.UserAvatar
	out.IsBookmarked = a.IsBookmarked
	if !withInstructions {
		out.Instructions = nil
	}
	return out
}

// instructionsOrEmpty ports `instructions: result.instructions ?? {}`
// (agent-repository.pg.ts:28): a NULL column reads back as an empty
// object, never null, so the frontend can always index into it.
func instructionsOrEmpty(raw []byte) json.RawMessage {
	if len(raw) == 0 {
		return json.RawMessage("{}")
	}
	return json.RawMessage(raw)
}

func isValidVisibility(v string) bool {
	return v == "public" || v == "private" || v == "readonly"
}

func writeAgentValidationError(w http.ResponseWriter, name string, description *string, visibility string) bool {
	if name == "" || len([]rune(name)) > 100 {
		httpjson.BadRequest(w, "name must be between 1 and 100 characters")
		return true
	}
	if description != nil && len([]rune(*description)) > 8000 {
		httpjson.BadRequest(w, "description must be at most 8000 characters")
		return true
	}
	if visibility != "" && !isValidVisibility(visibility) {
		httpjson.BadRequest(w, `visibility must be "public", "private" or "readonly"`)
		return true
	}
	return false
}

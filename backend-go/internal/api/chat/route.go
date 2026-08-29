package chat

import (
	"encoding/json"
	"errors"
	"net/http"

	"amiro/backend/internal/agent/workspace"
	bifrostai "amiro/backend/internal/ai/bifrost"
	"amiro/backend/internal/ai/tools"
	"amiro/backend/internal/ai/uimessage"
	"amiro/backend/internal/auth"
	"amiro/backend/internal/db/models"
)

// mentionDTO ports ChatMention (types/chat.ts:45)'s discriminated union
// flattened into one struct (Go has no native union types, same choice
// internal/ai/workflow/types.go's WorkflowToolKey already makes) -- Type
// selects which of the identifier fields is meaningful:
// mcpTool/mcpServer -> ServerID (+ Name for mcpTool's specific tool name),
// workflow -> WorkflowID, defaultTool -> Name. agent -> AgentID was removed
// in Phase 6 (docs/skills/) along with the rest of the agent feature.
type mentionDTO struct {
	Type       string `json:"type"`
	Name       string `json:"name"`
	ServerID   string `json:"serverId,omitempty"`
	WorkflowID string `json:"workflowId,omitempty"`
}

// allowedMCPServerDTO ports AllowedMCPServer (types/mcp.ts).
type allowedMCPServerDTO struct {
	Tools []string `json:"tools"`
}

// chatRequest ports chatApiSchemaRequestBodySchema (types/chat.ts:96).
// imageTool/attachments are still intentionally not read -- see
// shared.go's doc comment for the attachments gap; there's no image-
// generation tool in this rewrite's catalog to bind imageTool to.
type chatRequest struct {
	ID                       string                         `json:"id"`
	Message                  uiMessage                      `json:"message"`
	ChatModel                *chatModelDTO                  `json:"chatModel"`
	ToolChoice               string                         `json:"toolChoice"`
	Mentions                 []mentionDTO                   `json:"mentions"`
	AllowedAppDefaultToolkit *[]string                      `json:"allowedAppDefaultToolkit"`
	AllowedMcpServers        map[string]allowedMCPServerDTO `json:"allowedMcpServers"`
	// PermissionMode is "plan" | "manual" | "edit" | "auto". Absent or
	// unrecognized means interactive/manual -- see permission.ParseMode for why the
	// fallback is the asking mode rather than the permissive one.
	PermissionMode string `json:"permissionMode"`
	// WorkspaceRoot is the selected project directory to scope file and shell tools.
	WorkspaceRoot string `json:"workspaceRoot,omitempty"`
	ProjectDir    string `json:"projectDir,omitempty"`
	// CompactNow is not part of the TS schema this struct otherwise ports --
	// it is Amiro TUI-only (Phase 4's `/compact`), additive and optional, so
	// an absent key from the browser reads as false exactly like every
	// other zero value here. See runner.go's TurnRequest.CompactNow.
	CompactNow bool `json:"compactNow,omitempty"`
}

// chatMetadata ports ChatMetadata (types/chat.ts:7).
type chatMetadata struct {
	Usage      *bifrostai.Usage `json:"usage,omitempty"`
	ChatModel  *chatModelDTO    `json:"chatModel,omitempty"`
	ToolChoice string           `json:"toolChoice,omitempty"`
	ToolCount  int              `json:"toolCount"`

	// DurationMS is how long the whole turn spent working, summed across
	// every round an approval split it into.
	//
	// It is sent because the browser cannot measure it. A thread reopened
	// tomorrow has no start time to subtract from, and the work log's
	// fallback there was a step count -- which answers a different question
	// than the one "how long did that take?" asks.
	//
	// No omitempty: absent and zero mean different things to the reader of
	// this field. Absent is a message written before the server measured
	// anything, where the work log falls back to a step count; zero is a
	// turn that really was that fast.
	DurationMS int64 `json:"durationMs"`
}

// toolDeps builds the Deps a live chat request hands to tools.Defaults.
//
// Pulled out of Chat's body and named, rather than an inline literal, for
// one reason: an inline `tools.Deps{...}` that forgets a field fails
// silently. That happened here -- SearchRepo was added to the Deps struct
// and threaded all the way from main.go into the Handler, and then never
// actually reached this literal, so every live request built the web-search
// tools with a nil repository regardless of what was configured in the
// database. The tool's own error for that ("no provider configured") and
// the tool's error for "nothing is wired" are worded identically, so the
// bug looked like a data problem from the outside and passed every test
// that exercised the tool directly with a repo supplied by hand.
//
// A named function with its own return value is a thing TestToolDepsCarriesEverySearchRepo
// can assert on without standing up the rest of Chat's dependencies
// (thread lookup, model resolution, a live LLM stream). The inline literal
// had no such seam.
func (h *Handler) toolDeps(ws *workspace.Workspace, sessionID string) tools.Deps {
	return tools.Deps{
		Workspace:           ws,
		Todos:               h.todos,
		SessionID:           sessionID,
		Memory:              h.notes,
		LSP:                 h.lsp,
		SearchRepo:          h.searchRepo,
		SandboxNetworkAllow: h.sandboxNetworkAllow,
	}
}

// Chat ports route.ts's POST handler (chat/route.ts:57).
//
// It is now only the HTTP half of that: authenticate, decode the browser's
// request shape, and hand the turn to RunTurn (runner.go), which is what
// every surface shares. Everything this function used to do between those
// two points -- thread resolution, tool loading, prompt assembly, the tool
// loop, persistence -- moved there unchanged, because none of it ever
// touched the ResponseWriter or the Request.
func (h *Handler) Chat(w http.ResponseWriter, r *http.Request) {
	authedUser, ok := auth.UserFromContext(r.Context())
	if !ok {
		http.Error(w, "Unauthorized", http.StatusUnauthorized)
		return
	}

	var req chatRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		http.Error(w, "invalid request body", http.StatusBadRequest)
		return
	}

	// The Writer is built before RunTurn because it is RunTurn's output
	// channel, and it sets response headers without writing a status line --
	// so the error paths below can still choose their own status. The SSE
	// headers linger on those error responses, which is cosmetic: a client
	// reading a 403 reads the status and the body, not Cache-Control.
	turn, err := h.RunTurn(r.Context(), req.turn(authedUser), uimessage.NewWriter(w))
	switch {
	case errors.Is(err, ErrForbidden):
		http.Error(w, "Forbidden", http.StatusForbidden)
	case errors.Is(err, ErrInvalidTurn):
		http.Error(w, "id and message are required", http.StatusBadRequest)
	case err != nil:
		http.Error(w, err.Error(), http.StatusInternalServerError)
	default:
		_ = turn
	}
}

// turn adapts the browser's request shape to the transport-neutral one.
//
// A method on chatRequest rather than a constructor on TurnRequest so the
// wire DTO stays the thing that knows about the wire: a second surface that
// speaks a different shape converts its own, and neither has to know the
// other exists.
func (r chatRequest) turn(u *models.User) TurnRequest {
	return TurnRequest{
		User:                     u,
		ThreadID:                 r.ID,
		Message:                  r.Message,
		ChatModel:                r.ChatModel,
		ToolChoice:               r.ToolChoice,
		Mentions:                 r.Mentions,
		AllowedAppDefaultToolkit: r.AllowedAppDefaultToolkit,
		AllowedMcpServers:        r.AllowedMcpServers,
		PermissionMode:           r.PermissionMode,
		WorkspaceRoot:            r.WorkspaceRoot,
		ProjectDir:               r.ProjectDir,
		CompactNow:               r.CompactNow,
	}
}

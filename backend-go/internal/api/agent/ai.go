package agent

import (
	"encoding/json"
	"net/http"
	"sort"

	bifrostai "amiro/backend/internal/ai/bifrost"
	"amiro/backend/internal/ai/prompts"
	"amiro/backend/internal/api/httpjson"
	"amiro/backend/internal/auth"
)

// generateRequest ports agent/ai/route.ts's body (agent/ai/route.ts:26).
type generateRequest struct {
	ChatModel *struct {
		Provider string `json:"provider"`
		Model    string `json:"model"`
	} `json:"chatModel"`
	Message string `json:"message"`
}

// Generate ports agent/ai/route.ts's POST: ask the model to design an
// agent config, constrained to the tool names this user can actually bind.
//
// Two deliberate differences from the TS route, both about *how* the
// object comes back rather than what's in it:
//
//  1. Non-streaming. TS uses streamObject(...).toTextStreamResponse(),
//     which emits the JSON object progressively so the dialog can render
//     partial fields; internal/ai/bifrost has GenerateObject (Phase 5) but
//     no streamed-object equivalent, and Bifrost exposes no partial-object
//     protocol to build one on. The response is still a plain text stream
//     of the JSON object -- exactly the same content type and body shape
//     -- so useObject (generate-agent-dialog.tsx:44), which parses partial
//     JSON as it arrives, reads a single complete chunk without changes.
//     It just fills in all at once instead of progressively.
//
//  2. The tool enum is advisory, not enforced. TS builds a z.enum() of the
//     live tool names and hands it to streamObject, so the model
//     physically cannot emit an unknown tool. A JSON Schema enum over a
//     dynamic list does the same job here and is included below -- but
//     GenerateObject runs with strict:false (see its own doc comment), so
//     enforcement is best-effort. The prompt names the same list, and the
//     agent editor validates tool names again on save.
func (h *Handler) Generate(w http.ResponseWriter, r *http.Request) {
	if _, ok := auth.UserFromContext(r.Context()); !ok {
		httpjson.Unauthorized(w)
		return
	}

	var req generateRequest
	if !httpjson.Decode(w, r, &req) {
		return
	}
	if req.Message == "" {
		// `const { chatModel, message = "hello" } = json` (agent/ai/route.ts:26).
		req.Message = "hello"
	}

	toolNames := h.availableToolNames(r)
	system := prompts.BuildAgentGenerationPrompt(toolNames)

	provider, model := "", ""
	if req.ChatModel != nil {
		provider, model = req.ChatModel.Provider, req.ChatModel.Model
	}
	resolved := bifrostai.Resolve(provider, model)

	object, _, err := h.engine.GenerateObject(
		r.Context(), resolved, system,
		[]bifrostai.Message{{Role: bifrostai.RoleUser, Text: req.Message}},
		agentGenerateSchema(toolNames),
	)
	if err != nil {
		httpjson.ServerError(w, err)
		return
	}

	// The one header toTextStreamResponse sets, read out of
	// node_modules/ai/dist/index.js's createTextStreamResponse rather than
	// assumed -- the object is the body, not an SSE frame, and there is no
	// X-Vercel-AI-Data-Stream marker on this response shape (that belongs
	// to the *data* stream, which internal/ai/uimessage handles for chat).
	w.Header().Set("Content-Type", "text/plain; charset=utf-8")
	_, _ = w.Write(object)
}

// availableToolNames ports the three safe(...) blocks at
// agent/ai/route.ts:38-63: every MCP tool, plus every executable workflow.
// Each source failing is non-fatal (ts-safe's .unwrap() on a caught error
// leaves the set as-is), so a disconnected MCP server degrades the tool
// list rather than failing the request.
//
// The TS route has a fourth source, loadAppDefaultTools -- the built-in
// web-search/code-runner/image tool set. Those live entirely in the chat
// tool-calling loop, which Phase 3 left unported and nothing since has
// added, so there is no Go-side registry to enumerate; they reappear here
// automatically once that loop lands.
func (h *Handler) availableToolNames(r *http.Request) []string {
	authedUser, _ := auth.UserFromContext(r.Context())
	seen := map[string]bool{}
	var names []string
	add := func(name string) {
		if name == "" || seen[name] {
			return
		}
		seen[name] = true
		names = append(names, name)
	}

	if h.mcp != nil {
		if servers, err := h.mcp.List(r.Context(), authedUser.ID); err == nil {
			for _, server := range servers {
				for _, tool := range server.ToolInfo {
					add(tool.Name)
				}
			}
		}
	}
	if h.workflows != nil {
		if flows, err := h.workflows.SelectExecuteAbility(r.Context(), authedUser.ID); err == nil {
			for _, flow := range flows {
				add(flow.Workflow.Name)
			}
		}
	}

	sort.Strings(names)
	return names
}

// agentGenerateSchema ports AgentGenerateSchema (types/agent.ts:103) plus
// agent/ai/route.ts's dynamic `tools` enum extension (route.ts:65-80).
func agentGenerateSchema(toolNames []string) json.RawMessage {
	toolItems := map[string]any{"type": "string"}
	if len(toolNames) > 0 {
		toolItems["enum"] = toolNames
	}

	schema := map[string]any{
		"type": "object",
		"properties": map[string]any{
			"name":         map[string]any{"type": "string", "description": "Agent name"},
			"description":  map[string]any{"type": "string", "description": "Agent description"},
			"instructions": map[string]any{"type": "string", "description": "Agent instructions"},
			"role":         map[string]any{"type": "string", "description": "Agent role"},
			"tools": map[string]any{
				"type":        "array",
				"items":       toolItems,
				"description": "Agent allowed tools name",
			},
		},
		"required": []string{"name", "description", "instructions", "role"},
	}
	encoded, _ := json.Marshal(schema)
	return encoded
}

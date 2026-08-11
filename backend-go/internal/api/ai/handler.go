// Package ai ports the two generic, non-thread-bound generation Server
// Actions from src/app/api/chat/actions.ts that had no route.ts
// counterpart at all: generateObjectAction (workflow schema/parameter
// generation) and generateExampleToolSchemaAction (the MCP tool-test
// page's "fill an example input" button). Both are session-gated, neither
// touches the DB.
package ai

import (
	"context"
	"encoding/json"
	"net/http"

	bifrostai "betterchatbot/backend/internal/ai/bifrost"
	"betterchatbot/backend/internal/ai/prompts"
	"betterchatbot/backend/internal/api/httpjson"
	"betterchatbot/backend/internal/auth"
)

// Engine is the subset of *bifrostai.Client this package calls, narrowed
// the same way internal/api/chat.Engine and internal/api/agent.Engine are.
type Engine interface {
	GenerateObject(ctx context.Context, resolved bifrostai.ResolvedModel, system string, messages []bifrostai.Message, schema json.RawMessage) (json.RawMessage, *bifrostai.Usage, error)
}

type Handler struct {
	engine Engine
}

func NewHandler(engine Engine) *Handler {
	return &Handler{engine: engine}
}

type chatModelDTO struct {
	Provider string `json:"provider"`
	Model    string `json:"model"`
}

func (m *chatModelDTO) resolve() bifrostai.ResolvedModel {
	if m == nil {
		return bifrostai.Resolve("", "")
	}
	return bifrostai.Resolve(m.Provider, m.Model)
}

type promptDTO struct {
	System string `json:"system"`
	User   string `json:"user"`
}

type generateObjectRequest struct {
	Model  *chatModelDTO   `json:"model"`
	Prompt promptDTO       `json:"prompt"`
	Schema json.RawMessage `json:"schema"`
}

// GenerateObject ports generateObjectAction (chat/actions.ts:194).
func (h *Handler) GenerateObject(w http.ResponseWriter, r *http.Request) {
	if _, ok := auth.UserFromContext(r.Context()); !ok {
		httpjson.Unauthorized(w)
		return
	}

	var req generateObjectRequest
	if !httpjson.Decode(w, r, &req) {
		return
	}
	if len(req.Schema) == 0 {
		httpjson.BadRequest(w, "schema is required")
		return
	}

	object, _, err := h.engine.GenerateObject(
		r.Context(), req.Model.resolve(), req.Prompt.System,
		[]bifrostai.Message{{Role: bifrostai.RoleUser, Text: req.Prompt.User}},
		req.Schema,
	)
	if err != nil {
		httpjson.ServerError(w, err)
		return
	}

	w.Header().Set("Content-Type", "application/json")
	_, _ = w.Write(object)
}

type mcpToolInfoDTO struct {
	Name        string          `json:"name"`
	Description string          `json:"description"`
	InputSchema json.RawMessage `json:"inputSchema"`
}

type generateExampleToolSchemaRequest struct {
	Model    *chatModelDTO  `json:"model"`
	ToolInfo mcpToolInfoDTO `json:"toolInfo"`
	Prompt   string         `json:"prompt"`
}

// GenerateExampleToolSchema ports generateExampleToolSchemaAction
// (chat/actions.ts:117).
func (h *Handler) GenerateExampleToolSchema(w http.ResponseWriter, r *http.Request) {
	if _, ok := auth.UserFromContext(r.Context()); !ok {
		httpjson.Unauthorized(w)
		return
	}

	var req generateExampleToolSchemaRequest
	if !httpjson.Decode(w, r, &req) {
		return
	}

	schema := augmentToolInputSchema(req.ToolInfo.InputSchema)
	system := prompts.GenerateExampleToolSchemaPrompt(req.ToolInfo.Name, req.ToolInfo.Description, req.Prompt)

	object, _, err := h.engine.GenerateObject(
		r.Context(), req.Model.resolve(), system,
		[]bifrostai.Message{{Role: bifrostai.RoleUser, Text: ""}},
		schema,
	)
	if err != nil {
		httpjson.ServerError(w, err)
		return
	}

	w.Header().Set("Content-Type", "application/json")
	_, _ = w.Write(object)
}

// augmentToolInputSchema ports the object spread at chat/actions.ts:123-128:
// `{...inputSchema, properties: inputSchema?.properties ?? {},
// additionalProperties: false}` -- forces a "properties" key to always
// exist (jsonSchema()/GenerateObject both expect an object schema with a
// real properties map) and disables additional properties so the model
// can't invent fields outside what the tool actually accepts.
func augmentToolInputSchema(raw json.RawMessage) json.RawMessage {
	schema := map[string]any{}
	if len(raw) > 0 {
		_ = json.Unmarshal(raw, &schema)
	}
	if _, ok := schema["properties"]; !ok {
		schema["properties"] = map[string]any{}
	}
	if schema["type"] == nil {
		schema["type"] = "object"
	}
	schema["additionalProperties"] = false
	out, _ := json.Marshal(schema)
	return out
}

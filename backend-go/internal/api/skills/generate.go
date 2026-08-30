package skills

import (
	"context"
	"encoding/json"
	"net/http"

	bifrostai "amiro/backend/internal/ai/bifrost"
	"amiro/backend/internal/ai/prompts"
	"amiro/backend/internal/api/httpjson"
	"amiro/backend/internal/auth"
)

// Engine is the subset of *bifrostai.Client the generate route calls,
// narrowed to only what this route needs -- the same narrow
// consumer-declared interface pattern internal/api/chat.Engine uses -- so
// handler tests can substitute a fake without a live provider.
type Engine interface {
	GenerateObject(ctx context.Context, resolved bifrostai.ResolvedModel, system string, messages []bifrostai.Message, schema json.RawMessage) (json.RawMessage, *bifrostai.Usage, error)
}

// generateRequest is the POST /api/skills/generate body: a free-text
// description of the desired skill, plus an optional model override.
type generateRequest struct {
	ChatModel *struct {
		Provider string `json:"provider"`
		Model    string `json:"model"`
	} `json:"chatModel"`
	Message string `json:"message"`
}

// skillGenerateSchema is the JSON Schema the model's reply is constrained
// to: {name, description, body}, mirroring app-types/skill.ts's
// SkillGenerateSchema (src/types/skill.ts) and the fields
// generate-skill-dialog.tsx feeds into the editor form.
func skillGenerateSchema() json.RawMessage {
	schema := map[string]any{
		"type": "object",
		"properties": map[string]any{
			"name":        map[string]any{"type": "string", "description": "Skill directory name (lowercase, digits, single hyphens)"},
			"description": map[string]any{"type": "string", "description": "What the skill does and when to use it"},
			"body":        map[string]any{"type": "string", "description": "The SKILL.md markdown body (no frontmatter)"},
		},
		"required": []string{"name", "description", "body"},
	}
	encoded, _ := json.Marshal(schema)
	return encoded
}

// Generate handles POST /api/skills/generate: ask the model to draft a
// SKILL.md {name, description, body} from a free-text prompt.
//
// Nothing reaches disk from this route -- it only calls the engine and
// writes the object back to the response; the model drafts, and the
// ordinary create/update endpoint (plus its validator) is the only path
// from a draft to a file. The response is a plain JSON-text body rather
// than an SSE stream because Bifrost's GenerateObject has no
// partial-object protocol to stream from, and experimental_useObject reads
// a single complete chunk either way.
func (h *Handler) Generate(w http.ResponseWriter, r *http.Request) {
	if _, ok := auth.UserFromContext(r.Context()); !ok {
		httpjson.Unauthorized(w)
		return
	}
	if h.engine == nil {
		httpjson.ServerError(w, errNoEngine)
		return
	}

	var req generateRequest
	if !httpjson.Decode(w, r, &req) {
		return
	}
	if req.Message == "" {
		req.Message = "a helpful skill"
	}

	provider, model := "", ""
	if req.ChatModel != nil {
		provider, model = req.ChatModel.Provider, req.ChatModel.Model
	}
	resolved := bifrostai.Resolve(provider, model)

	object, _, err := h.engine.GenerateObject(
		r.Context(), resolved, prompts.BuildSkillGenerationPrompt(),
		[]bifrostai.Message{{Role: bifrostai.RoleUser, Text: req.Message}},
		skillGenerateSchema(),
	)
	if err != nil {
		httpjson.ServerError(w, err)
		return
	}

	// A plain JSON-text body, not an SSE frame -- see this function's doc
	// comment.
	w.Header().Set("Content-Type", "text/plain; charset=utf-8")
	_, _ = w.Write(object)
}

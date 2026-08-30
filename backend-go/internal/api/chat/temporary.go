package chat

import (
	"encoding/json"
	"net/http"
	"strings"

	bifrostai "amiro/backend/internal/ai/bifrost"
	"amiro/backend/internal/ai/prompts"
	"amiro/backend/internal/ai/uimessage"
	"amiro/backend/internal/auth"
	"amiro/backend/internal/db/models"
	"amiro/backend/internal/user"
)

type temporaryRequest struct {
	Messages     []uiMessage   `json:"messages"`
	ChatModel    *chatModelDTO `json:"chatModel"`
	Instructions string        `json:"instructions"`
}

// Temporary ports temporary/route.ts's POST handler: a stateless streaming
// chat completion, never persisted -- no thread, no saved messages.
func (h *Handler) Temporary(w http.ResponseWriter, r *http.Request) {
	authedUser, ok := auth.UserFromContext(r.Context())
	if !ok {
		http.Error(w, "Unauthorized", http.StatusUnauthorized)
		return
	}

	var req temporaryRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		http.Error(w, "invalid request body", http.StatusBadRequest)
		return
	}

	chatModel := chatModelDTO{}
	if req.ChatModel != nil {
		chatModel = *req.ChatModel
	}
	resolved := bifrostai.Resolve(chatModel.Provider, chatModel.Model)

	system := prompts.BuildUserSystemPrompt(authedUser, user.ParsePreferences(authedUser.Preferences))
	if req.Instructions != "" {
		system = strings.TrimSpace(system + "\n\n" + req.Instructions)
	}

	engineMessages := make([]bifrostai.Message, 0, len(req.Messages))
	for _, m := range req.Messages {
		engineMessages = append(engineMessages, m.toEngineMessages()...)
	}

	responseID := models.NewID()
	sw := uimessage.NewWriter(w)
	_ = sw.Start(responseID)

	// See title.go's identical fix for why a Stream() failure here must
	// stay inside the SSE framing (an early raw http.Error breaks the AI
	// SDK client's stream parser) rather than a plain-text 500.
	chunks, err := h.engine.Stream(r.Context(), resolved, system, engineMessages)
	if err != nil {
		_ = sw.Error(err.Error())
		_ = sw.Finish(nil)
		_ = sw.Done()
		return
	}

	_ = sw.StartStep()
	_ = sw.TextStart(responseID)
	for chunk := range chunks {
		if chunk.Err != nil {
			_ = sw.Error(chunk.Err.Error())
			continue
		}
		if chunk.TextDelta != "" {
			_ = sw.TextDelta(responseID, chunk.TextDelta)
		}
	}
	_ = sw.TextEnd(responseID)
	_ = sw.FinishStep()
	_ = sw.Finish(nil)
	_ = sw.Done()
}

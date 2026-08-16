package chat

import (
	"encoding/json"
	"net/http"

	bifrostai "amiro/backend/internal/ai/bifrost"
	"amiro/backend/internal/ai/prompts"
	"amiro/backend/internal/ai/uimessage"
	"amiro/backend/internal/auth"
	"amiro/backend/internal/db/models"
)

type titleRequest struct {
	ChatModel *chatModelDTO `json:"chatModel"`
	Message   string        `json:"message"`
	ThreadID  string        `json:"threadId"`
}

// Title ports title/route.ts's POST handler: streams a generated thread
// title back, and on completion upserts it onto the thread (matching the
// TS route's `onFinish` callback -- there is no separate "save title"
// endpoint).
func (h *Handler) Title(w http.ResponseWriter, r *http.Request) {
	authedUser, ok := auth.UserFromContext(r.Context())
	if !ok {
		http.Error(w, "Unauthorized", http.StatusUnauthorized)
		return
	}

	var req titleRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		http.Error(w, "invalid request body", http.StatusBadRequest)
		return
	}
	if req.Message == "" {
		req.Message = "hello"
	}
	if req.ThreadID == "" {
		http.Error(w, "threadId is required", http.StatusBadRequest)
		return
	}

	chatModel := chatModelDTO{}
	if req.ChatModel != nil {
		chatModel = *req.ChatModel
	}
	resolved := bifrostai.Resolve(chatModel.Provider, chatModel.Model)

	ctx := r.Context()
	responseID := models.NewID()
	sw := uimessage.NewWriter(w)
	_ = sw.Start(responseID)

	// A Stream() failure here (found live, not assumed: an unavailable OS
	// keychain in a headless dev environment triggers exactly this) must
	// still be written as a properly-framed SSE error event, not a raw
	// http.Error -- the client is the AI SDK's useCompletion, which
	// expects the data-stream wire format on every response regardless of
	// outcome; a plain-text 500 body makes its parser throw with an
	// opaque "Cannot read properties of undefined" instead of the
	// intended graceful no-op-on-failure UX (route.ts's own
	// generateTitle caller silently swallows a failed title generation).
	chunks, err := h.engine.Stream(ctx, resolved, prompts.CreateThreadTitlePrompt, []bifrostai.Message{
		{Role: bifrostai.RoleUser, Text: req.Message},
	})
	if err != nil {
		_ = sw.Error(err.Error())
		_ = sw.Finish(nil)
		_ = sw.Done()
		return
	}

	_ = sw.StartStep()
	_ = sw.TextStart(responseID)

	var title string
	for chunk := range chunks {
		if chunk.Err != nil {
			_ = sw.Error(chunk.Err.Error())
			continue
		}
		if chunk.TextDelta != "" {
			title += chunk.TextDelta
			_ = sw.TextDelta(responseID, chunk.TextDelta)
		}
	}

	_ = sw.TextEnd(responseID)
	_ = sw.FinishStep()
	_ = sw.Finish(nil)
	_ = sw.Done()

	if title != "" {
		_ = h.chats.UpsertThread(ctx, &models.ChatThread{ID: req.ThreadID, Title: title, UserID: authedUser.ID})
	}
}

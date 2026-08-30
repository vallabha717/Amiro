package chat

import (
	"bytes"
	"encoding/json"
	"io"
	"net/http"
	"strings"
	"time"

	"amiro/backend/internal/ai/prompts"
	"amiro/backend/internal/ai/speech"
	"amiro/backend/internal/auth"
	"amiro/backend/internal/user"
)

type realtimeRequest struct {
	Voice string `json:"voice"`
}

var realtimeHTTPClient = &http.Client{Timeout: 30 * time.Second}

// OpenAIRealtime ports openai-realtime/route.ts's POST handler: mints a
// short-lived OpenAI realtime session token. MCP tool binding (loadMcpTools)
// is still not wired in here -- only the default client-side voice tools
// are bound here. (The agent-mention binding this comment used to also
// name, rememberAgentAction, no longer exists: the agent feature it would
// have bound was decommissioned in Phase 6, docs/skills/.)
func (h *Handler) OpenAIRealtime(w http.ResponseWriter, r *http.Request) {
	_, baseURL, apiKey, err := h.providerRepo.GetProviderBaseURLAndKey(r.Context(), "openai")
	if err != nil || apiKey == "" {
		http.Error(w, `{"error":"OPENAI_API_KEY is not set"}`, http.StatusInternalServerError)
		return
	}

	authedUser, ok := auth.UserFromContext(r.Context())
	if !ok {
		http.Error(w, "Unauthorized", http.StatusUnauthorized)
		return
	}

	var req realtimeRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		http.Error(w, "invalid request body", http.StatusBadRequest)
		return
	}
	voice := req.Voice
	if voice == "" {
		voice = "alloy"
	}

	systemPrompt := prompts.BuildSpeechSystemPrompt(authedUser, user.ParsePreferences(authedUser.Preferences))

	body, _ := json.Marshal(map[string]any{
		"model": "gpt-4o-realtime-preview",
		"voice": voice,
		"input_audio_transcription": map[string]any{
			"model": "whisper-1",
		},
		"instructions": systemPrompt,
		"tools":        speech.DefaultVoiceTools(),
	})

	targetURL := "https://api.openai.com/v1/realtime/sessions"
	if baseURL != "" {
		trimmed := strings.TrimSuffix(baseURL, "/")
		if !strings.HasSuffix(trimmed, "/v1") {
			trimmed += "/v1"
		}
		targetURL = trimmed + "/realtime/sessions"
	}

	upstreamReq, err := http.NewRequestWithContext(r.Context(), http.MethodPost, targetURL, bytes.NewReader(body))
	if err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}
	upstreamReq.Header.Set("Authorization", "Bearer "+apiKey)
	upstreamReq.Header.Set("Content-Type", "application/json")

	resp, err := realtimeHTTPClient.Do(upstreamReq)
	if err != nil {
		http.Error(w, err.Error(), http.StatusBadGateway)
		return
	}
	defer resp.Body.Close()

	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(resp.StatusCode)
	_, _ = io.Copy(w, resp.Body)
}

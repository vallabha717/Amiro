package workflow

import (
	"context"
	"encoding/json"
	"net/http"
	"time"

	"amiro/backend/internal/ai/workflow/executor"
	"amiro/backend/internal/auth"
)

// executeTimeout matches the TS route's `timeout: 1000 * 60 * 5` passed to
// app.run (execute/route.ts:85).
const executeTimeout = 5 * time.Minute

// Execute ports workflow/[id]/execute/route.ts's POST handler: streams
// WF_EVENT-framed JSON lines (encodeWorkflowEvent's exact wire format) as
// the workflow runs, so the existing frontend (shared.workflow.ts's
// decodeWorkflowEvents, execute-tab.tsx) keeps working unchanged. Client
// disconnect is handled for free by r.Context() cancelling when the
// underlying connection closes -- no separate `request.signal` listener
// needed the way the TS route sets one up.
func (h *Handler) Execute(w http.ResponseWriter, r *http.Request) {
	authedUser, ok := auth.UserFromContext(r.Context())
	if !ok {
		unauthorized(w)
		return
	}
	id := r.PathValue("id")

	hasAccess, err := h.repo.CheckAccess(r.Context(), id, authedUser.ID, true)
	if err != nil {
		serverError(w, err)
		return
	}
	if !hasAccess {
		unauthorized(w)
		return
	}

	var body struct {
		Query map[string]interface{} `json:"query"`
	}
	if r.Body != nil {
		_ = json.NewDecoder(r.Body).Decode(&body)
	}

	structure, err := h.repo.SelectStructureByID(r.Context(), id, false)
	if err != nil {
		serverError(w, err)
		return
	}
	if structure == nil {
		http.Error(w, "Workflow not found", http.StatusNotFound)
		return
	}

	ctx, cancel := context.WithTimeout(r.Context(), executeTimeout)
	defer cancel()

	w.Header().Set("Content-Type", "application/octet-stream")
	w.Header().Set("Cache-Control", "no-cache")
	w.Header().Set("Connection", "keep-alive")
	w.WriteHeader(http.StatusOK)
	flusher, _ := w.(http.Flusher)

	events := executor.Run(ctx, h.bifrost, h.mcp, structure.Nodes, structure.Edges, body.Query)
	for ev := range events {
		b, err := json.Marshal(ev)
		if err != nil {
			continue
		}
		if _, err := w.Write([]byte("WF_EVENT:")); err != nil {
			return
		}
		if _, err := w.Write(b); err != nil {
			return
		}
		if _, err := w.Write([]byte("\n")); err != nil {
			return
		}
		if flusher != nil {
			flusher.Flush()
		}
	}
}

package workflow

import (
	"net/http"

	"amiro/backend/internal/auth"
)

// ExecuteAbility ports workflow/tools/route.ts's GET handler: every
// published workflow the caller may run. Named "tools" in the TS route
// because the frontend uses this list to populate workflow-as-tool pickers
// (chat @-mentions) -- that chat-tool-calling wiring itself is out of
// Phase 5's scope (see handler.go's doc comment), but the listing endpoint
// itself is plain workflow data, so it's ported here.
func (h *Handler) ExecuteAbility(w http.ResponseWriter, r *http.Request) {
	authedUser, ok := auth.UserFromContext(r.Context())
	if !ok {
		unauthorized(w)
		return
	}
	rows, err := h.repo.SelectExecuteAbility(r.Context(), authedUser.ID)
	if err != nil {
		serverError(w, err)
		return
	}
	writeJSON(w, toWorkflowSummaries(rows))
}

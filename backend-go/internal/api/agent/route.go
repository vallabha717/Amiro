package agent

import (
	"encoding/json"
	"net/http"
	"strconv"
	"strings"

	"amiro/backend/internal/api/httpjson"
	"amiro/backend/internal/auth"
	"amiro/backend/internal/db/models"

	"gorm.io/datatypes"
)

// List ports agent/route.ts's GET, including AgentQuerySchema's defaults
// and its comma-separated `filters` override of the single `type` param
// (agent/route.ts:26-32).
func (h *Handler) List(w http.ResponseWriter, r *http.Request) {
	authedUser, ok := auth.UserFromContext(r.Context())
	if !ok {
		httpjson.Unauthorized(w)
		return
	}

	query := r.URL.Query()

	filterType := query.Get("type")
	if filterType == "" {
		filterType = "all"
	}
	if !isValidFilter(filterType) {
		httpjson.BadRequest(w, "Invalid query parameters: type")
		return
	}

	filters := []string{filterType}
	if raw := query.Get("filters"); raw != "" {
		filters = nil
		for _, f := range strings.Split(raw, ",") {
			f = strings.TrimSpace(f)
			if !isValidFilter(f) {
				httpjson.BadRequest(w, "Invalid query parameters: filters")
				return
			}
			filters = append(filters, f)
		}
	}

	limit := 50
	if raw := query.Get("limit"); raw != "" {
		parsed, err := strconv.Atoi(raw)
		if err != nil || parsed < 1 || parsed > 100 {
			httpjson.BadRequest(w, "Invalid query parameters: limit must be between 1 and 100")
			return
		}
		limit = parsed
	}

	rows, err := h.agents.SelectAgents(r.Context(), authedUser.ID, filters, limit)
	if err != nil {
		httpjson.ServerError(w, err)
		return
	}

	out := make([]agentResponse, 0, len(rows))
	for _, row := range rows {
		out = append(out, toAgentWithMetaResponse(row, false))
	}
	httpjson.OK(w, out)
}

func isValidFilter(f string) bool {
	switch f {
	case "all", "mine", "shared", "bookmarked":
		return true
	}
	return false
}

// createRequest ports AgentCreateSchema (types/agent.ts:17). userId is
// deliberately absent: the schema declares one, but agent/route.ts:74
// overwrites it with the session's user id, so accepting it from the body
// would only create a way to spoof it.
type createRequest struct {
	Name         string          `json:"name"`
	Description  *string         `json:"description"`
	Icon         json.RawMessage `json:"icon"`
	Instructions json.RawMessage `json:"instructions"`
	Visibility   string          `json:"visibility"`
}

// Create ports agent/route.ts's POST.
func (h *Handler) Create(w http.ResponseWriter, r *http.Request) {
	authedUser, ok := auth.UserFromContext(r.Context())
	if !ok {
		httpjson.Unauthorized(w)
		return
	}

	var req createRequest
	if !httpjson.Decode(w, r, &req) {
		return
	}
	if writeAgentValidationError(w, req.Name, req.Description, req.Visibility) {
		return
	}

	agent := &models.Agent{
		Name:        req.Name,
		Description: req.Description,
		UserID:      authedUser.ID,
		Visibility:  req.Visibility,
	}
	if len(req.Icon) > 0 {
		agent.Icon = datatypes.JSON(req.Icon)
	}
	if len(req.Instructions) > 0 {
		agent.Instructions = datatypes.JSON(req.Instructions)
	}

	if err := h.agents.Insert(r.Context(), agent); err != nil {
		httpjson.ServerError(w, err)
		return
	}
	httpjson.OK(w, toAgentResponse(*agent))
}

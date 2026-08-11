package chat

import (
	"encoding/json"
	"net/http"
	"sort"

	bifrostai "betterchatbot/backend/internal/ai/bifrost"
)

// Models ports models/route.ts's GET handler: the catalog, sorted with
// hasAPIKey providers first (the TS route's own `.sort` step, kept
// separate from ListModels' catalog-order output).
func (h *Handler) Models(w http.ResponseWriter, r *http.Request) {
	info := bifrostai.ListModels(r.Context(), h.secrets)
	sort.SliceStable(info, func(i, j int) bool {
		if info[i].HasAPIKey == info[j].HasAPIKey {
			return false
		}
		return info[i].HasAPIKey
	})
	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(info)
}

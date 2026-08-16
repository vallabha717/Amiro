package chat

import (
	"encoding/json"
	"net/http"

	bifrostai "amiro/backend/internal/ai/bifrost"
)

// Models ports models/route.ts's GET handler: the catalog, sorted with
// hasAPIKey providers first (the TS route's own `.sort` step, kept
// separate from ListModels' catalog-order output).
func (h *Handler) Models(w http.ResponseWriter, r *http.Request) {
	info := bifrostai.ListModels(r.Context(), h.providerRepo)

	var configured []bifrostai.ProviderModelsInfo
	for _, p := range info {
		if p.HasAPIKey {
			configured = append(configured, p)
		}
	}

	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(configured)
}

package archive

import (
	"net/http"

	"betterchatbot/backend/internal/api/httpjson"
)

// ListItems ports archive/[id]/items/route.ts's GET.
func (h *Handler) ListItems(w http.ResponseWriter, r *http.Request) {
	archive, _ := h.requireOwnedArchive(w, r)
	if archive == nil {
		return
	}

	items, err := h.archives.GetItems(r.Context(), archive.ID)
	if err != nil {
		httpjson.ServerError(w, err)
		return
	}

	out := make([]itemResponse, 0, len(items))
	for _, item := range items {
		out = append(out, toItemResponse(item))
	}
	httpjson.OK(w, out)
}

// addItemRequest ports AddItemSchema (archive/[id]/items/route.ts:5).
type addItemRequest struct {
	ItemID string `json:"itemId"`
}

// AddItem ports archive/[id]/items/route.ts's POST.
func (h *Handler) AddItem(w http.ResponseWriter, r *http.Request) {
	archive, authedUser := h.requireOwnedArchive(w, r)
	if archive == nil {
		return
	}

	var req addItemRequest
	if !httpjson.Decode(w, r, &req) {
		return
	}
	if req.ItemID == "" {
		httpjson.BadRequest(w, "itemId is required")
		return
	}

	item, err := h.archives.AddItem(r.Context(), archive.ID, req.ItemID, authedUser.ID)
	if err != nil {
		httpjson.ServerError(w, err)
		return
	}
	httpjson.OK(w, toItemResponse(*item))
}

// RemoveItem ports archive/[id]/items/[itemId]/route.ts's DELETE,
// including its "is the item actually in this archive" check -- which is
// what makes removing an absent item a 404 rather than a silent success.
func (h *Handler) RemoveItem(w http.ResponseWriter, r *http.Request) {
	archive, _ := h.requireOwnedArchive(w, r)
	if archive == nil {
		return
	}

	itemID := r.PathValue("itemId")
	items, err := h.archives.GetItems(r.Context(), archive.ID)
	if err != nil {
		httpjson.ServerError(w, err)
		return
	}
	found := false
	for _, item := range items {
		if item.ItemID == itemID {
			found = true
			break
		}
	}
	if !found {
		httpjson.NotFound(w, "Item not found in archive")
		return
	}

	if err := h.archives.RemoveItem(r.Context(), archive.ID, itemID); err != nil {
		httpjson.ServerError(w, err)
		return
	}
	httpjson.Success(w)
}

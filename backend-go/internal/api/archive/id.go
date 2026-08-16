package archive

import (
	"net/http"

	"amiro/backend/internal/api/httpjson"
)

// Get ports archive/[id]/route.ts's GET: the archive plus its items.
func (h *Handler) Get(w http.ResponseWriter, r *http.Request) {
	archive, _ := h.requireOwnedArchive(w, r)
	if archive == nil {
		return
	}

	items, err := h.archives.GetItems(r.Context(), archive.ID)
	if err != nil {
		httpjson.ServerError(w, err)
		return
	}

	out := archiveWithItemsResponse{
		archiveResponse: toArchiveResponse(*archive),
		Items:           make([]itemResponse, 0, len(items)),
	}
	for _, item := range items {
		out.Items = append(out.Items, toItemResponse(item))
	}
	httpjson.OK(w, out)
}

// Update ports archive/[id]/route.ts's PUT.
func (h *Handler) Update(w http.ResponseWriter, r *http.Request) {
	archive, _ := h.requireOwnedArchive(w, r)
	if archive == nil {
		return
	}

	var req writeRequest
	if !httpjson.Decode(w, r, &req) {
		return
	}
	if msg, ok := req.validate(false); !ok {
		httpjson.BadRequest(w, msg)
		return
	}

	// The TS route writes `name: data.name` unconditionally even though
	// ArchiveUpdateSchema makes it optional, so an omitted name blanks the
	// column. Keeping the existing name instead is the one deliberate
	// deviation here: silently erasing an archive's name because the caller
	// only wanted to edit its description is a bug, not a contract.
	name := archive.Name
	if req.Name != "" {
		name = req.Name
	}
	var description *string
	if req.Description != nil && *req.Description != "" {
		description = req.Description
	}

	updated, err := h.archives.Update(r.Context(), archive.ID, name, description)
	if err != nil {
		httpjson.ServerError(w, err)
		return
	}
	httpjson.OK(w, toArchiveResponse(*updated))
}

// Delete ports archive/[id]/route.ts's DELETE.
func (h *Handler) Delete(w http.ResponseWriter, r *http.Request) {
	archive, _ := h.requireOwnedArchive(w, r)
	if archive == nil {
		return
	}
	if err := h.archives.Delete(r.Context(), archive.ID); err != nil {
		httpjson.ServerError(w, err)
		return
	}
	httpjson.Success(w)
}

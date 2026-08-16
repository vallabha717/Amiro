// Package archive ports src/app/api/archive/**: archive CRUD plus its
// item membership routes. Every route is owner-only -- an archive is a
// private folder of the user's own threads, with no visibility/sharing
// concept at all, so there is none of the ownership-vs-visibility logic
// internal/api/{agent,workflow,mcp} each need.
package archive

import (
	"net/http"
	"strings"
	"time"

	"amiro/backend/internal/api/httpjson"
	"amiro/backend/internal/auth"
	"amiro/backend/internal/db/models"
	"amiro/backend/internal/db/repository"
)

type Handler struct {
	archives *repository.ArchiveRepository
}

func NewHandler(archives *repository.ArchiveRepository) *Handler {
	return &Handler{archives: archives}
}

// internal/db/models carries no json tags by convention (see
// internal/api/auth's userResponse), so these DTOs give the wire the
// camelCase shape types/archive.ts already declares.

type archiveResponse struct {
	ID          string    `json:"id"`
	Name        string    `json:"name"`
	Description *string   `json:"description"`
	UserID      string    `json:"userId"`
	CreatedAt   time.Time `json:"createdAt"`
	UpdatedAt   time.Time `json:"updatedAt"`
}

func toArchiveResponse(a models.Archive) archiveResponse {
	return archiveResponse{
		ID: a.ID, Name: a.Name, Description: a.Description, UserID: a.UserID,
		CreatedAt: a.CreatedAt, UpdatedAt: a.UpdatedAt,
	}
}

type archiveWithCountResponse struct {
	archiveResponse
	ItemCount int64 `json:"itemCount"`
}

type itemResponse struct {
	ID        string    `json:"id"`
	ArchiveID string    `json:"archiveId"`
	ItemID    string    `json:"itemId"`
	UserID    string    `json:"userId"`
	AddedAt   time.Time `json:"addedAt"`
}

func toItemResponse(i models.ArchiveItem) itemResponse {
	return itemResponse{
		ID: i.ID, ArchiveID: i.ArchiveID, ItemID: i.ItemID, UserID: i.UserID, AddedAt: i.AddedAt,
	}
}

// archiveWithItemsResponse ports archive/[id]/route.ts's GET body, which
// spreads the archive and appends its items (archive/[id]/route.ts:33).
type archiveWithItemsResponse struct {
	archiveResponse
	Items []itemResponse `json:"items"`
}

// writeRequest ports ArchiveCreateSchema/ArchiveUpdateSchema
// (types/archive.ts:3). Both share one Go shape: the create route requires
// a name, the update route doesn't, which validate() below distinguishes.
type writeRequest struct {
	Name        string  `json:"name"`
	Description *string `json:"description"`
}

func (req writeRequest) validate(nameRequired bool) (string, bool) {
	name := strings.TrimSpace(req.Name)
	if nameRequired && name == "" {
		return "name is required", false
	}
	if len(req.Name) > 100 {
		return "name must be at most 100 characters", false
	}
	if req.Description != nil && len(*req.Description) > 500 {
		return "description must be at most 500 characters", false
	}
	return "", true
}

// requireOwnedArchive resolves the {id} path value and enforces the
// 401/404/403 ladder every archive/[id]/** route repeats verbatim: no
// session -> 401, no such archive -> 404, someone else's -> 403. Returns
// nil once it has written the response.
func (h *Handler) requireOwnedArchive(w http.ResponseWriter, r *http.Request) (*models.Archive, *models.User) {
	authedUser, ok := auth.UserFromContext(r.Context())
	if !ok {
		httpjson.Unauthorized(w)
		return nil, nil
	}

	archive, err := h.archives.GetByID(r.Context(), r.PathValue("id"))
	if err != nil {
		httpjson.ServerError(w, err)
		return nil, nil
	}
	if archive == nil {
		httpjson.NotFound(w, "Archive not found")
		return nil, nil
	}
	if archive.UserID != authedUser.ID {
		httpjson.Forbidden(w)
		return nil, nil
	}
	return archive, authedUser
}

// Package checkpoint exposes /rewind over HTTP: listing which files a turn
// checkpointed (for the confirmation both surfaces render before reverting)
// and triggering the restore itself. internal/agent/checkpoint is the
// enforcement point -- this package is only how a human's "rewind to here"
// reaches it. See docs/coding-agent-parity/02-checkpoints-and-rewind.md.
package checkpoint

import (
	"context"

	"amiro/backend/internal/agent/checkpoint"
	"amiro/backend/internal/agent/permission"
	"amiro/backend/internal/db/models"
	"amiro/backend/internal/db/repository"
	"amiro/backend/internal/storage"
)

// ThreadAccess is the narrow slice of *repository.ChatRepository this
// package needs: proof the caller owns the thread it's asking to rewind,
// nothing else -- the same "consumer-declares-the-interface" shape the
// backend skill asks for so a handler test can fake it without a real db.
type ThreadAccess interface {
	CheckAccess(ctx context.Context, threadID, userID string) (bool, error)
}

// Handler holds every dependency the /api/checkpoint/** routes need.
type Handler struct {
	repo   *repository.CheckpointFileRepository
	blobs  storage.Storage
	chats  ThreadAccess
	grants *permission.Store
}

// NewHandler wires the routes. grants must be the same *permission.Store
// runner.go's turns take their write-lock from (chat.Handler.Grants()) --
// two different stores would mean a restore's exclusive Lock and a turn's
// RLock never actually contend, defeating the whole point of the lock. See
// permission.Session.writeMu's doc comment.
func NewHandler(repo *repository.CheckpointFileRepository, blobs storage.Storage, chats ThreadAccess, grants *permission.Store) *Handler {
	return &Handler{repo: repo, blobs: blobs, chats: chats, grants: grants}
}

type fileResponse struct {
	Path          string `json:"path"`
	ExistedBefore bool   `json:"existedBefore"`
}

type filesResponse struct {
	TurnID string         `json:"turnId"`
	Files  []fileResponse `json:"files"`
}

func toFilesResponse(turnID string, rows []models.CheckpointFile) filesResponse {
	resp := filesResponse{TurnID: turnID, Files: make([]fileResponse, 0, len(rows))}
	for _, r := range rows {
		resp.Files = append(resp.Files, fileResponse{Path: r.Path, ExistedBefore: r.ExistedBefore})
	}
	return resp
}

type restoreFileResponse struct {
	Path          string `json:"path"`
	ExistedBefore bool   `json:"existedBefore"`
	Restored      bool   `json:"restored"`
	Error         string `json:"error,omitempty"`
}

type restoreResponse struct {
	TurnID string                `json:"turnId"`
	Files  []restoreFileResponse `json:"files"`
}

func toRestoreResponse(result checkpoint.Result) restoreResponse {
	resp := restoreResponse{TurnID: result.TurnID, Files: make([]restoreFileResponse, 0, len(result.Files))}
	for _, f := range result.Files {
		resp.Files = append(resp.Files, restoreFileResponse{
			Path: f.Path, ExistedBefore: f.ExistedBefore, Restored: f.Restored, Error: f.Error,
		})
	}
	return resp
}

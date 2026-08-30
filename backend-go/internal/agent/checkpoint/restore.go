package checkpoint

import (
	"context"
	"fmt"
	"io"
	"os"
	"path/filepath"

	"amiro/backend/internal/agent/workspace"
	"amiro/backend/internal/db/repository"
	"amiro/backend/internal/storage"
)

// FileResult is one checkpointed file's restore outcome.
type FileResult struct {
	Path          string `json:"path"`
	ExistedBefore bool   `json:"existedBefore"`
	Restored      bool   `json:"restored"`

	// Error is set, and Restored false, when this one file could not be
	// reverted -- a workspace root that no longer resolves, a moved parent
	// directory, an evicted blob. Per-file, never fatal to the rest of the
	// restore: docs/coding-agent-parity/02-checkpoints-and-rewind.md is
	// explicit that one bad path is "refused for that file, reported, and
	// does not abort the rest."
	Error string `json:"error,omitempty"`
}

// Result is what one restore_checkpoint call produced.
type Result struct {
	TurnID string       `json:"turnId"`
	Files  []FileResult `json:"files"`
}

// Restore reverts every file checkpointed for (threadID, turnID): writes
// each blob's pre-image bytes back, or deletes the file when it did not
// exist before the turn (the asymmetric case
// docs/coding-agent-parity/02-checkpoints-and-rewind.md calls out by name).
//
// It does not touch the conversation transcript and does not cascade to any
// other turn -- both deliberate non-features of the design, not omissions.
//
// The caller is responsible for holding the thread's write lock
// (permission.Session.Lock) for the duration of this call, so a restore can
// never interleave with a live turn's writes to the same thread; Restore
// itself has no opinion on locking; it is a pure filesystem operation over
// whatever rows the repository returns.
func Restore(ctx context.Context, repo *repository.CheckpointFileRepository, blobs storage.Storage, threadID, turnID string) (Result, error) {
	rows, err := repo.ListForTurn(ctx, threadID, turnID)
	if err != nil {
		return Result{}, fmt.Errorf("checkpoint: list: %w", err)
	}

	res := Result{TurnID: turnID}
	wsCache := map[string]*workspace.Workspace{}

	for _, row := range rows {
		fr := FileResult{Path: row.Path, ExistedBefore: row.ExistedBefore}

		ws, cached := wsCache[row.ResolvedRoot]
		if !cached {
			var wsErr error
			ws, wsErr = workspace.New(row.ResolvedRoot)
			wsCache[row.ResolvedRoot] = ws
			if wsErr != nil {
				fr.Error = fmt.Sprintf("workspace root no longer available: %v", wsErr)
				res.Files = append(res.Files, fr)
				continue
			}
		}
		if ws == nil {
			fr.Error = "workspace root no longer available"
			res.Files = append(res.Files, fr)
			continue
		}

		abs, err := ws.Resolve(row.Path)
		if err != nil {
			fr.Error = err.Error()
			res.Files = append(res.Files, fr)
			continue
		}

		if row.ExistedBefore {
			data, err := readBlob(ctx, blobs, row.BlobKey)
			if err != nil {
				fr.Error = err.Error()
				res.Files = append(res.Files, fr)
				continue
			}
			if err := os.MkdirAll(filepath.Dir(abs), 0o755); err != nil {
				fr.Error = err.Error()
				res.Files = append(res.Files, fr)
				continue
			}
			if err := os.WriteFile(abs, data, 0o644); err != nil {
				fr.Error = err.Error()
				res.Files = append(res.Files, fr)
				continue
			}
		} else if err := os.Remove(abs); err != nil && !os.IsNotExist(err) {
			fr.Error = err.Error()
			res.Files = append(res.Files, fr)
			continue
		}

		fr.Restored = true
		res.Files = append(res.Files, fr)
	}
	return res, nil
}

func readBlob(ctx context.Context, blobs storage.Storage, key string) ([]byte, error) {
	rc, err := blobs.Get(ctx, key)
	if err != nil {
		return nil, fmt.Errorf("checkpoint blob unavailable: %w", err)
	}
	defer rc.Close()
	return io.ReadAll(rc)
}

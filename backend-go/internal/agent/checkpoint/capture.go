// Package checkpoint captures the pre-image of every file a turn is about
// to write, and restores it -- Phase 1 of
// docs/coding-agent-parity/README.md, settled by
// docs/coding-agent-parity/02-checkpoints-and-rewind.md.
//
// A checkpoint is not a full-workspace snapshot; git already exists for
// that. It is the exact bytes of one file, as they stood the moment before
// a turn's first write_file/edit_file/multi_edit call against it, stored in
// the same content-addressed blob store attachments already use
// (internal/storage) and indexed by internal/db/repository's
// CheckpointFileRepository.
package checkpoint

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"os"

	"amiro/backend/internal/agent/workspace"
	"amiro/backend/internal/db/models"
	"amiro/backend/internal/db/repository"
	"amiro/backend/internal/storage"
)

// blobPrefix namespaces checkpoint pre-image blobs in the shared blob
// store, distinguishing them from attachment keys (storage.DefaultPrefix)
// sharing the same backend.
const blobPrefix = "checkpoints/"

// Capturer captures one turn's file pre-images, lazily, the first time each
// distinct path is about to be written within it.
type Capturer struct {
	repo             *repository.CheckpointFileRepository
	blobs            storage.Storage
	ws               *workspace.Workspace
	threadID, turnID string
}

// NewCapturer returns nil if any required dependency is missing -- the
// "optional dependency degrades rather than panics" contract every other
// checkpoint-adjacent wiring in this tree already has (chat.Handler.trust,
// h.notes, ...). A nil *Capturer's Capture is a documented no-op, so a
// caller never has to nil-check before calling it.
func NewCapturer(repo *repository.CheckpointFileRepository, blobs storage.Storage, ws *workspace.Workspace, threadID, turnID string) *Capturer {
	if repo == nil || blobs == nil || ws == nil || threadID == "" || turnID == "" {
		return nil
	}
	return &Capturer{repo: repo, blobs: blobs, ws: ws, threadID: threadID, turnID: turnID}
}

// Capture records relPath's pre-image if this is the first write to it
// within the turn. Best-effort and silent on failure by design: a
// checkpoint that could not be captured (a path that fails to resolve, a
// storage error) must never block the write it precedes -- an agent that
// cannot check out a safety net is still better than one that cannot write
// at all. The absence of a checkpoint simply means that turn's rewind
// affordance won't cover this file, which every caller checks for at
// render/restore time rather than assuming always exists (see restore.go).
func (c *Capturer) Capture(ctx context.Context, relPath string) {
	if c == nil {
		return
	}
	abs, err := c.ws.Resolve(relPath)
	if err != nil {
		return
	}
	rel, err := c.ws.Rel(abs)
	if err != nil {
		return
	}

	if has, err := c.repo.HasCheckpoint(ctx, c.threadID, c.turnID, rel); err != nil || has {
		return
	}

	info, statErr := os.Stat(abs)
	if statErr == nil && info.IsDir() {
		// A checkpoint is a file pre-image; the write this precedes will
		// fail against a directory target on its own, and there is nothing
		// meaningful to capture for one.
		return
	}
	existed := statErr == nil

	var blobKey string
	if existed {
		data, readErr := os.ReadFile(abs)
		if readErr != nil {
			return
		}
		sum := sha256.Sum256(data)
		blobKey = blobPrefix + hex.EncodeToString(sum[:])
		if err := c.blobs.Put(ctx, blobKey, bytes.NewReader(data)); err != nil {
			return
		}
	}

	_ = c.repo.Capture(ctx, models.CheckpointFile{
		ThreadID:      c.threadID,
		TurnID:        c.turnID,
		Path:          rel,
		ResolvedRoot:  c.ws.Root(),
		BlobKey:       blobKey,
		ExistedBefore: existed,
	})
}

package apiclient

import (
	"context"
	"net/url"
)

// CheckpointFile mirrors backend-go/internal/api/checkpoint's unexported
// fileResponse -- one file a turn checkpointed.
type CheckpointFile struct {
	Path          string `json:"path"`
	ExistedBefore bool   `json:"existedBefore"`
}

// CheckpointFiles mirrors backend-go/internal/api/checkpoint's unexported
// filesResponse.
type CheckpointFiles struct {
	TurnID string           `json:"turnId"`
	Files  []CheckpointFile `json:"files"`
}

// CheckpointRestoreFile mirrors backend-go/internal/api/checkpoint's
// unexported restoreFileResponse -- one file's outcome from a restore.
type CheckpointRestoreFile struct {
	Path          string `json:"path"`
	ExistedBefore bool   `json:"existedBefore"`
	Restored      bool   `json:"restored"`
	Error         string `json:"error,omitempty"`
}

// CheckpointRestoreResult mirrors backend-go/internal/api/checkpoint's
// unexported restoreResponse.
type CheckpointRestoreResult struct {
	TurnID string                  `json:"turnId"`
	Files  []CheckpointRestoreFile `json:"files"`
}

// CheckpointFilesFor lists a specific turn's checkpointed files.
func (c *Client) CheckpointFilesFor(ctx context.Context, threadID, turnID string) (CheckpointFiles, error) {
	var out CheckpointFiles
	err := c.Get(ctx, "/api/checkpoint/files?threadId="+url.QueryEscape(threadID)+"&turnId="+url.QueryEscape(turnID), &out)
	return out, err
}

// LatestCheckpoint resolves "the most recent turn with checkpoints" for a
// thread -- empty TurnID means there is nothing to rewind.
func (c *Client) LatestCheckpoint(ctx context.Context, threadID string) (CheckpointFiles, error) {
	var out CheckpointFiles
	err := c.Get(ctx, "/api/checkpoint/latest?threadId="+url.QueryEscape(threadID), &out)
	return out, err
}

// RestoreCheckpoint reverts every file checkpointed for (threadID, turnID).
func (c *Client) RestoreCheckpoint(ctx context.Context, threadID, turnID string) (CheckpointRestoreResult, error) {
	var out CheckpointRestoreResult
	err := c.Post(ctx, "/api/checkpoint/restore", map[string]string{"threadId": threadID, "turnId": turnID}, &out)
	return out, err
}

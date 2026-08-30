package apiclient

import "context"

// BackgroundJob mirrors backend-go/internal/api/backgroundjob's unexported
// jobResponse -- docs/coding-agent-parity/05-background-agent-runs.md.
type BackgroundJob struct {
	ID            string `json:"id"`
	ThreadID      string `json:"threadId"`
	WorkspaceRoot string `json:"workspaceRoot"`
	Prompt        string `json:"prompt"`
	Mode          string `json:"mode"`
	Status        string `json:"status"`
	AutoPR        bool   `json:"autoPr"`
	Error         string `json:"error,omitempty"`
	StartedAt     string `json:"startedAt"`
	FinishedAt    string `json:"finishedAt,omitempty"`
}

// CreateBackgroundJobRequest mirrors the handler's unexported createRequest.
type CreateBackgroundJobRequest struct {
	Prompt        string `json:"prompt"`
	Mode          string `json:"mode"`
	WorkspaceRoot string `json:"workspaceRoot,omitempty"`
	AutoPR        bool   `json:"autoPr,omitempty"`
}

// CreateBackgroundJob starts a new background job.
func (c *Client) CreateBackgroundJob(ctx context.Context, req CreateBackgroundJobRequest) (BackgroundJob, error) {
	var out BackgroundJob
	err := c.Post(ctx, "/api/background-jobs", req, &out)
	return out, err
}

// GetBackgroundJob reads one job's current status, for polling.
func (c *Client) GetBackgroundJob(ctx context.Context, id string) (BackgroundJob, error) {
	var out BackgroundJob
	err := c.Get(ctx, join("/api/background-jobs", id), &out)
	return out, err
}

// ListBackgroundJobs returns the caller's own jobs (or, for an admin, every
// user's).
func (c *Client) ListBackgroundJobs(ctx context.Context) ([]BackgroundJob, error) {
	var out struct {
		Jobs []BackgroundJob `json:"jobs"`
	}
	err := c.Get(ctx, "/api/background-jobs", &out)
	return out.Jobs, err
}

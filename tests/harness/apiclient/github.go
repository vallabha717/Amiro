package apiclient

import "context"

// GitHubStatusResponse mirrors backend-go/internal/api/github's unexported
// statusResponse -- GET /api/github/status's shape. Never carries the
// token itself, only whether one is stored
// (docs/coding-agent-parity/04-git-remote-operations.md).
type GitHubStatusResponse struct {
	Connected bool `json:"connected"`
}

func (c *Client) GitHubStatus(ctx context.Context) (GitHubStatusResponse, error) {
	var out GitHubStatusResponse
	err := c.Get(ctx, "/api/github/status", &out)
	return out, err
}

func (c *Client) ConnectGitHub(ctx context.Context, token string) (GitHubStatusResponse, error) {
	var out GitHubStatusResponse
	err := c.Post(ctx, "/api/github/connect", map[string]string{"token": token}, &out)
	return out, err
}

func (c *Client) DisconnectGitHub(ctx context.Context) error {
	return c.Post(ctx, "/api/github/disconnect", nil, nil)
}

package apiclient

import "context"

// SandboxStatusResponse mirrors backend-go/internal/api/sandbox's
// unexported statusResponse -- GET /api/sandbox/status's shape.
type SandboxStatusResponse struct {
	Backend   string `json:"backend"`
	Sandboxed bool   `json:"sandboxed"`
}

// SandboxStatus reports the attached server's detected run_shell sandbox
// backend (docs/coding-agent-parity/03-sandboxed-execution.md).
func (c *Client) SandboxStatus(ctx context.Context) (SandboxStatusResponse, error) {
	var out SandboxStatusResponse
	err := c.Get(ctx, "/api/sandbox/status", &out)
	return out, err
}

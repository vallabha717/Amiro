package apiclient

import (
	"context"
	"net/url"
)

// WorkspaceTrustStatus mirrors backend-go/internal/api/workspacetrust's
// unexported statusResponse.
type WorkspaceTrustStatus struct {
	Trusted      bool   `json:"trusted"`
	ResolvedRoot string `json:"resolvedRoot"`
}

// WorkspaceTrustGrant mirrors backend-go/internal/api/workspacetrust's
// unexported grantResponse -- one row of GET /api/workspace-trust.
type WorkspaceTrustGrant struct {
	ResolvedRoot string `json:"resolvedRoot"`
	GrantedAt    string `json:"grantedAt"`
	GrantedVia   string `json:"grantedVia"`
}

// WorkspaceTrustStatusFor reports whether the caller has already granted
// root -- root is resolved server-side, so a raw (unresolved) path works.
func (c *Client) WorkspaceTrustStatusFor(ctx context.Context, root string) (WorkspaceTrustStatus, error) {
	var out WorkspaceTrustStatus
	err := c.Get(ctx, "/api/workspace-trust/status?root="+url.QueryEscape(root), &out)
	return out, err
}

// GrantWorkspaceTrust is the trust prompt's "yes" answer.
func (c *Client) GrantWorkspaceTrust(ctx context.Context, root string) (WorkspaceTrustStatus, error) {
	var out WorkspaceTrustStatus
	err := c.Post(ctx, "/api/workspace-trust/grant", map[string]string{"root": root}, &out)
	return out, err
}

// RevokeWorkspaceTrust removes a prior grant for root, if one exists.
func (c *Client) RevokeWorkspaceTrust(ctx context.Context, root string) error {
	return c.Post(ctx, "/api/workspace-trust/revoke", map[string]string{"root": root}, nil)
}

// ListWorkspaceTrust returns every root the caller has granted.
func (c *Client) ListWorkspaceTrust(ctx context.Context) ([]WorkspaceTrustGrant, error) {
	var out struct {
		Grants []WorkspaceTrustGrant `json:"grants"`
	}
	err := c.Get(ctx, "/api/workspace-trust", &out)
	return out.Grants, err
}

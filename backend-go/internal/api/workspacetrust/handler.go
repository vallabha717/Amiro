// Package workspacetrust exposes the trust-grant model
// (docs/coding-agent-parity/01-workspace-trust-and-rules.md) over HTTP: can
// the current user write to / run commands in a given root, and if not, a
// route to grant or revoke that consent. The permission engine is the
// enforcement point (internal/agent/permission); this package is only how a
// human answers the prompt that engine's refusal implies.
package workspacetrust

import (
	"time"

	"amiro/backend/internal/agent/workspace"
	"amiro/backend/internal/db/models"
	"amiro/backend/internal/db/repository"
)

type Handler struct {
	trust *repository.WorkspaceTrustRepository

	// defaultRoot is the server's own configured workspace root
	// (cfg.WorkspaceRoot's resolved form), empty when none is configured
	// (a multi-user "serve" deployment). Status uses it via
	// IsTrustedForTurn so a check made before any turn has ever run
	// reports the same answer a turn would have produced as a side
	// effect -- otherwise a first-open prompt would show for a workspace
	// that was never actually going to ask.
	defaultRoot string
}

func NewHandler(trust *repository.WorkspaceTrustRepository, defaultRoot string) *Handler {
	return &Handler{trust: trust, defaultRoot: defaultRoot}
}

// resolveRoot turns a client-supplied path into the same symlink-resolved
// absolute form workspace.Workspace.Root() produces -- the exact value a
// grant is keyed on, and the only place in this package a path gets
// resolved (see the design doc's note on not inventing a second
// normalization routine).
func resolveRoot(root string) (string, error) {
	ws, err := workspace.New(root)
	if err != nil {
		return "", err
	}
	return ws.Root(), nil
}

type statusResponse struct {
	Trusted      bool   `json:"trusted"`
	ResolvedRoot string `json:"resolvedRoot"`
}

type grantResponse struct {
	ResolvedRoot string    `json:"resolvedRoot"`
	GrantedAt    time.Time `json:"grantedAt"`
	GrantedVia   string    `json:"grantedVia"`
}

type listResponse struct {
	Grants []grantResponse `json:"grants"`
}

func toGrantResponse(g models.WorkspaceTrust) grantResponse {
	return grantResponse{ResolvedRoot: g.ResolvedRoot, GrantedAt: g.GrantedAt, GrantedVia: g.GrantedVia}
}

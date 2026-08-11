package mcp

import "betterchatbot/backend/internal/db/models"

// CanManage ports canManageMCPServer (lib/auth/permissions.ts): admins can
// manage any server, everyone else only their own private ones.
//
// TS's fuller resource-permission system (roles.ts's per-role "create"/
// "update"/"delete" statements for the "mcp" resource) is not ported here
// -- this Go backend's auth model (internal/auth, Phase 2) only ever
// assigns a plain "user"/"admin" role, not TS's three-tier user/editor/admin
// with per-resource statements. Porting that whole statement system wasn't
// in Phase 4's scope, and applying its "user" tier literally (view/use/list
// only, no create) would leave the desktop single-user unable to ever add
// an MCP server -- a regression against this rewrite's own primary target.
// Any authenticated user may create/manage their own servers instead;
// admin-gated is only "make a server public" (CanShare), which is the one
// permission every role tier agrees is admin-only.
func CanManage(user *models.User, ownerID, visibility string) bool {
	if user == nil {
		return false
	}
	if user.Role == "admin" {
		return true
	}
	return user.ID == ownerID && visibility == "private"
}

// CanShare ports canShareMCPServer (lib/auth/permissions.ts): only admins
// may feature (make public) an MCP server.
func CanShare(user *models.User) bool {
	return user != nil && user.Role == "admin"
}

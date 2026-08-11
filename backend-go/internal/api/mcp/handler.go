// Package mcp ports src/app/api/mcp/**: server CRUD, listing, per-user
// server/tool customizations, and the OAuth authorize/callback routes
// (oauth.go) backing internal/mcp/oauth's flow.
//
// A few endpoints below (refresh, share, tool-call) don't correspond to an
// existing route.ts file -- in the TS app they're Next.js Server Actions
// (mcp/actions.ts, a "use server" file), reachable only from React
// components today. Plan section 6's module map assigns converting all 11
// "use server" files to real HTTP endpoints to Phase 7. These three are
// exposed early anyway, the same way internal/api/auth's HTTP surface got
// ahead of its own phase in Phase 2: without them there is no way to
// exercise -- or even manually test -- most of what Manager does.
package mcp

import (
	"betterchatbot/backend/internal/db/repository"
	"betterchatbot/backend/internal/mcp"
)

// Handler holds every dependency the api/mcp/** routes need.
type Handler struct {
	manager      *mcp.Manager
	serverCustom *repository.McpServerCustomizationRepository
	toolCustom   *repository.McpToolCustomizationRepository
}

func NewHandler(manager *mcp.Manager, serverCustom *repository.McpServerCustomizationRepository, toolCustom *repository.McpToolCustomizationRepository) *Handler {
	return &Handler{manager: manager, serverCustom: serverCustom, toolCustom: toolCustom}
}

// Client-side permission helpers.
//
// The Go sidecar's auth model (backend-go/internal/auth, Phase 2) only
// ever assigns two roles, "user" and "admin" -- there is no "editor" tier
// and no per-resource create/update/delete/view/use/share statement
// table. backend-go/internal/mcp/permissions.go, internal/api/workflow,
// and internal/api/agent's own doc comments all independently drew the
// same conclusion for the same reason: applying the old three-tier
// TS role-statement system literally (plain "user" = view/use/list only,
// no create) would leave the desktop single-user unable to ever create an
// agent, workflow, or MCP server -- a regression against the rewrite's own
// primary target. These helpers mirror that resolved backend behavior
// instead of the old statement table, so the UI doesn't hide a button the
// server would actually allow: any authenticated user may create, edit,
// use, and view their own resources; only *sharing* (making an MCP server
// public) stays admin-gated, the one permission every tier agreed was
// admin-only.

export function canCreateAgent(_userRoleString?: string | null): boolean {
  return true;
}

export function canEditAgent(_userRoleString?: string | null): boolean {
  return true;
}

export function canDeleteAgent(_userRoleString?: string | null): boolean {
  return true;
}

export function canCreateWorkflow(_userRoleString?: string | null): boolean {
  return true;
}

export function canEditWorkflow(_userRoleString?: string | null): boolean {
  return true;
}

export function canDeleteWorkflow(_userRoleString?: string | null): boolean {
  return true;
}

export function canCreateMCP(_userRoleString?: string | null): boolean {
  return true;
}

export function canEditMCP(_userRoleString?: string | null): boolean {
  return true;
}

export function canChangeVisibilityMCP(userRoleString?: string | null): boolean {
  return userRoleString === "admin";
}

export function canDeleteMCP(_userRoleString?: string | null): boolean {
  return true;
}

export function canUseResource(
  _userRoleString?: string | null,
  _resourceType: "agent" | "workflow" | "mcp" = "agent",
): boolean {
  return true;
}

export function canViewResource(
  _userRoleString?: string | null,
  _resourceType: "agent" | "workflow" | "mcp" = "agent",
): boolean {
  return true;
}

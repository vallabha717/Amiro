// Client-side permission helpers.
//
// The Go sidecar's auth model (backend-go/internal/auth, Phase 2) only
// ever assigns two roles, "user" and "admin" -- there is no "editor" tier
// and no per-resource create/update/delete/view/use/share statement
// table. backend-go/internal/mcp/permissions.go and internal/api/workflow's
// own doc comments independently drew the same conclusion for the same
// reason: applying the old three-tier TS role-statement system literally
// (plain "user" = view/use/list only, no create) would leave the desktop
// single-user unable to ever create a workflow or MCP server -- a
// regression against the rewrite's own primary target. These helpers mirror
// that resolved backend behavior
// instead of the old statement table, so the UI doesn't hide a button the
// server would actually allow: any authenticated user may create, edit,
// use, and view their own resources; only *sharing* (making an MCP server
// public) stays admin-gated, the one permission every tier agreed was
// admin-only.

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
  _resourceType: "workflow" | "mcp" = "workflow",
): boolean {
  return true;
}

export function canViewResource(
  _userRoleString?: string | null,
  _resourceType: "workflow" | "mcp" = "workflow",
): boolean {
  return true;
}

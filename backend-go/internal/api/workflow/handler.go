// Package workflow ports src/app/api/workflow/**: workflow CRUD, structure
// (nodes/edges) read/write, the streaming execute route, and the
// execute-ability listing endpoint. Node execution itself lives in
// internal/ai/workflow/executor -- this package is HTTP glue only, the same
// split Phase 3/4 drew between internal/api/chat and internal/ai/bifrost,
// internal/api/mcp and internal/mcp.
//
// Permission model: any authenticated user may create a workflow and manage
// (edit/delete/publish) their own, gated purely by
// WorkflowRepository.CheckAccess's ownership/visibility rules -- the TS
// route's additional canCreateWorkflow/canEditWorkflow/canDeleteWorkflow
// role-tier gate (workflow: ["view","use","list"] for the plain "user" role,
// full access for "editor"/"admin") is not ported, for the same reason
// mcp.CanManage's doc comment gives: this Go backend's auth model only ever
// assigns "user"/"admin", and the desktop auto-login user is always "user"
// -- applying the TS "user" tier literally would leave the desktop
// single-user unable to ever create a workflow.
package workflow

import (
	"betterchatbot/backend/internal/ai/workflow/executor"
	"betterchatbot/backend/internal/db/repository"
)

// Handler holds every dependency the api/workflow/** routes need. bifrost/
// mcp are the same narrowed interfaces internal/ai/workflow/executor's own
// node executors use (executor.Engine / executor.MCPCaller), so handler
// tests can substitute fakes the same way internal/api/chat's Engine does.
type Handler struct {
	repo    *repository.WorkflowRepository
	bifrost executor.Engine
	mcp     executor.MCPCaller
}

func NewHandler(repo *repository.WorkflowRepository, bf executor.Engine, mgr executor.MCPCaller) *Handler {
	return &Handler{repo: repo, bifrost: bf, mcp: mgr}
}

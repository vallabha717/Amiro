package toolcard

import "amiro/backend/internal/tui/session"

// Tool names, mirroring internal/ai/tools.Name* -- kept as local string
// literals rather than an import for the same reason session/reduce.go
// gives (this package's doc comment repeats it, since it's the fact that
// matters most about every file here).
const (
	toolNameReadFile  = "read_file"
	toolNameListDir   = "list_dir"
	toolNameGlob      = "glob"
	toolNameGrep      = "grep"
	toolNameWriteFile = "write_file"
	toolNameEditFile  = "edit_file"
	toolNameMultiEdit = "multi_edit"
	toolNameRunShell  = "run_shell"
	toolNameTodoWrite = "todo_write"
	toolNameTodoRead  = "todo_read"
)

// registry maps a tool name to its renderer. Anything not listed here --
// git, task, repo_map, lsp, memory_*, propose_plan, walkthrough, and every
// MCP tool -- renders through renderGeneric (Render's fallback). Phase 2's
// scope is "diff / shell / files / generic" (the plan's own Phase 2 exit
// criteria); todo_write/todo_read got a dedicated renderer anyway because
// the generic fallback's raw-JSON dump was actively illegible for a tool
// this common (see plan.go) -- the rest get a card in whichever later
// phase actually needs one, the same way src/components/tool-presenters'
// registry grew one tool at a time.
var registry = map[string]func(int, session.ToolCall) string{
	toolNameReadFile:  renderReadFile,
	toolNameListDir:   renderListDir,
	toolNameGlob:      renderGlob,
	toolNameGrep:      renderGrep,
	toolNameWriteFile: renderWriteFile,
	toolNameEditFile:  renderEditFile,
	toolNameMultiEdit: renderEditFile,
	toolNameRunShell:  renderShell,
	toolNameTodoWrite: renderPlan,
	toolNameTodoRead:  renderPlan,
}

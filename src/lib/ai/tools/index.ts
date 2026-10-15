export enum AppDefaultToolkit {
  Visualization = "visualization",
  WebSearch = "webSearch",
  Http = "http",
  Terminal = "terminal",
  Code = "terminal", // alias
  File = "file",
  // Durable notes about the workspace. A real toggle, unlike the plan
  // tools -- a note that changes how the agent behaves in every future
  // conversation is something a user should be able to switch off.
  Memory = "memory",
}

export enum DefaultToolName {
  CreatePieChart = "createPieChart",
  CreateBarChart = "createBarChart",
  CreateLineChart = "createLineChart",
  CreateTable = "createTable",
  WebSearch = "webSearch",
  WebContent = "webContent",
  Http = "http",
  TerminalExecution = "terminal-execution",
  RunShell = "run_shell",
  // File ACI -- only offered when the backend has a workspace root
  // configured (BETTERCHATBOT_WORKSPACE_ROOT).
  ReadFile = "read_file",
  ListDir = "list_dir",
  WriteFile = "write_file",
  Glob = "glob",
  Grep = "grep",
  EditFile = "edit_file",
  MultiEdit = "multi_edit",
  Git = "git",
  // Git remote operations (docs/coding-agent-parity/, Phase 3). Only
  // offered alongside Git -- see internal/ai/tools.Defaults.
  CreatePR = "create_pr",
  // Context & scale (Phase 4).
  TodoWrite = "todo_write",
  TodoRead = "todo_read",
  Task = "task",
  // Plan review and the end-of-turn summary (Phase 6). propose_plan has no
  // server-side executor: it suspends the turn and the browser answers it,
  // which is why the artifact pane is what resolves the call.
  ProposePlan = "propose_plan",
  Walkthrough = "walkthrough",
  // Orientation, symbol intelligence and durable notes (Phase 4.4 / 5).
  // repo_map needs only a workspace; lsp additionally needs a language
  // server installed, and the memory tools an app data directory -- so
  // any of these may legitimately be absent from a given turn.
  RepoMap = "repo_map",
  Lsp = "lsp",
  MemoryWrite = "memory_write",
  MemoryRead = "memory_read",
  MemoryForget = "memory_forget",
}

export const SequentialThinkingToolName = "sequential-thinking";

export const ImageToolName = "image-manager";

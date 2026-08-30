// Package client is the terminal UI's only connection to a transport.
//
// Plan §2.2 (docs/tui-implementation-plan.md) settled this: the TUI is a
// client of the backend, over HTTP + SSE, the same way the desktop app is --
// never an in-process caller of chat.RunTurn. That is what makes the
// approval rail, the tool loop and persistence exactly one implementation
// shared by both surfaces instead of two that can drift.
//
// Everything above this package -- app, page, component, session -- takes a
// Client and a uimessage.Frame and must not know whether the other end of
// that Client is an embedded server on a loopback port or an attached
// desktop sidecar. That is the whole point of the interface: swapping http.go
// for a fake in a test costs nothing above this line.
package client

import (
	"context"
	"encoding/json"
	"time"

	"amiro/backend/internal/ai/uimessage"
)

// SendMessageRequest is one turn's input, transport-neutral the same way
// chat.TurnRequest is on the server side -- this package's job is to turn it
// into whatever chatRequest's wire shape requires.
type SendMessageRequest struct {
	// ThreadID is the conversation this turn belongs to. The server creates
	// it on first use (chat.RunTurn), so the client is free to mint one at
	// session start and never ask the server whether it exists yet.
	ThreadID string

	// MessageID identifies this user message, freshly minted per send.
	MessageID string

	// Text is the message body. Phase 1 sends plain text only -- no
	// attachments, no mentions.
	Text string

	// WorkspaceRoot scopes the turn's file and shell tools. The TUI always
	// sets this to the directory it was launched from.
	WorkspaceRoot string

	// PermissionMode is "plan" | "interactive" | "edit" | "auto" -- empty
	// reads as interactive (permission.ParseMode's own fallback). Phase 3's
	// live mode switching; Phase 1/2 always left this empty.
	PermissionMode string

	// ChatModel, if set, pins this turn to a specific provider/model
	// instead of the server's default -- Phase 3's model picker.
	ChatModel *ChatModel

	// Mentions are the @-mentions resolved out of the composer -- Phase 4's
	// mention support. Nil/empty changes nothing (isToolCallAllowed's own
	// zero-value behavior, runner.go).
	Mentions []Mention

	// CompactNow forces this turn's history to compact immediately, even
	// under the automatic budget -- the TUI's `/compact` command
	// (chat.TurnRequest.CompactNow).
	CompactNow bool
}

// Mention selects one thing to give the turn extra access to, mirroring
// chatapi's unexported mentionDTO exactly (field-for-field, so http.go's
// wire encoding needs no translation beyond the json tags):
//
//	{Type: "mcpServer", ServerID: id}                -- every tool on that server
//	{Type: "mcpTool", ServerID: id, Name: toolName}  -- one tool on that server
//	{Type: "workflow", WorkflowID: id}               -- a workflow-as-tool
//	{Type: "defaultTool", Name: toolName}            -- one of Amiro's own tools
//	{Type: "skill", Name: skillName}                 -- full skill instructions injected into turn
type Mention struct {
	Type       string
	Name       string
	ServerID   string
	WorkflowID string
}

// ChatModel selects a provider/model pair, mirroring chatapi's unexported
// chatModelDTO.
type ChatModel struct {
	Provider string
	Model    string
}

// AssistantResubmission resends a paused assistant message with the human's
// answer to a suspended tool call already folded into Parts -- the same
// rail the desktop app's AI SDK resubmit uses (plan §2.4). Parts is the
// *entire* message so far, in wire shape: RunTurn's "continuing" branch
// persists this array as-is, spliced with whatever the next round adds
// (runner.go), so a caller must send everything, not just the answered
// part -- session.State.BuildApprovalResubmission builds exactly that.
type AssistantResubmission struct {
	ThreadID       string
	MessageID      string
	Parts          []json.RawMessage
	WorkspaceRoot  string
	PermissionMode string
}

// ThreadSummary is one row of GET /api/thread -- enough to list, search and
// pick a thread without its messages.
type ThreadSummary struct {
	ID            string
	Title         string
	CreatedAt     time.Time
	LastMessageAt int64 // unix millis, 0 if the thread has no messages yet
}

// ThreadMessage is one persisted message's wire shape, mirroring
// threadapi's messageResponse -- Parts stays raw for the same reason it
// does everywhere else in this tree: decoding it is session's job
// (session.ReplayThread), not this package's.
type ThreadMessage struct {
	ID       string
	Role     string
	Parts    []json.RawMessage
	Metadata json.RawMessage
}

// ThreadDetail is one thread's full history, GET /api/thread/{id}'s shape.
type ThreadDetail struct {
	ID       string
	Title    string
	Messages []ThreadMessage
}

// ProviderModels is one provider's offering, mirroring
// bifrostai.ProviderModelsInfo -- GET /api/chat/models already filters to
// providers with a configured key, so every entry here is one the model
// picker can actually select.
type ProviderModels struct {
	Provider     string
	ProviderName string
	Models       []string
}

// MCPServer is a mentionable server plus the tools on it, GET
// /api/mcp/list's row shape reduced the same way.
type MCPServer struct {
	ID    string
	Name  string
	Tools []string
}

// Workflow is a mentionable workflow, GET /api/workflow's row shape reduced
// the same way.
type Workflow struct {
	ID   string
	Name string
}

// ShadowedSkill describes a skill shadowed by another skill of higher precedence.
type ShadowedSkill struct {
	Name     string
	Scope    string
	Source   string
	Path     string
	RealPath string
	Reason   string
}

// SkillDiagnostic describes a parsing or structural issue encountered while scanning a skill.
type SkillDiagnostic struct {
	Path     string
	Skill    string
	Severity string
	Message  string
}

// SkillSummary is one discovered skill, GET /api/skills's row shape.
type SkillSummary struct {
	Name                   string
	Description            string
	Scope                  string
	Source                 string
	Path                   string
	RealPath               string
	Writable               bool
	DisableModelInvocation bool
	Shadows                []ShadowedSkill
}

// SkillListResult is the response from GET /api/skills.
type SkillListResult struct {
	Items       []SkillSummary
	Diagnostics []SkillDiagnostic
	Truncated   bool
}

// ProviderStatus is one configured (or configurable) AI provider -- the
// settings page's (page/settings.go) view of GET /api/ai/providers.
type ProviderStatus struct {
	ID         string
	Name       string
	Provider   string
	Configured bool
}

// CheckpointFile is one file a turn checkpointed -- what /rewind's
// confirmation lists before reverting
// (docs/coding-agent-parity/02-checkpoints-and-rewind.md).
type CheckpointFile struct {
	Path          string
	ExistedBefore bool
}

// CheckpointRestoreResult is one file's outcome from a restore -- Restored
// false with a non-empty Error means that one file was refused (a moved
// workspace, an evicted blob) without aborting the rest.
type CheckpointRestoreResult struct {
	Path          string
	ExistedBefore bool
	Restored      bool
	Error         string
}

// Client is what a page talks to. A page must never reach past it for an
// http.Client, a base URL, or a token -- see the package doc for why.
type Client interface {
	// SendMessage starts one turn and returns the frames it streams back.
	//
	// The returned channel is closed when the stream ends, however it ends
	// -- a clean [DONE], a canceled ctx, or a dropped connection. wait
	// blocks until the channel is closed and returns the reason: nil for a
	// clean finish, ctx.Err() for an interrupt, or the transport error that
	// closed the connection early. Callers that only care about the frames
	// can ignore wait's return until after the channel closes; calling it
	// before does not miss any frames -- it exists to distinguish those
	// three outcomes without threading a second value through the channel.
	SendMessage(ctx context.Context, req SendMessageRequest) (frames <-chan uimessage.Frame, wait func() error)

	// SubmitApproval resumes a turn a data-tool-approval frame paused, with
	// the same streaming contract as SendMessage.
	SubmitApproval(ctx context.Context, req AssistantResubmission) (frames <-chan uimessage.Frame, wait func() error)

	// ListThreads, GetThread and DeleteThread back the thread switcher
	// (page/threads.go).
	ListThreads(ctx context.Context) ([]ThreadSummary, error)
	GetThread(ctx context.Context, id string) (ThreadDetail, error)
	DeleteThread(ctx context.Context, id string) error

	// ListModels backs the model picker (page/models.go).
	ListModels(ctx context.Context) ([]ProviderModels, error)

	// ListMCPServers and ListWorkflows back @-mention completion
	// (component/editor/mention.go) -- every mentionable thing that isn't
	// one of Amiro's own built-in tools (which need no fetch;
	// editor.DefaultToolMentions is a static list).
	ListMCPServers(ctx context.Context) ([]MCPServer, error)
	ListWorkflows(ctx context.Context) ([]Workflow, error)

	// ListSkills backs slash-command completion and the `/skills` command,
	// fetching skills for the given project workspace root from GET /api/skills.
	ListSkills(ctx context.Context, project string) (SkillListResult, error)

	// ExportThread creates a shareable export of a thread and returns its
	// id -- the TUI's `/export` command. The share URL is
	// "<web origin>/export/<id>"; this package has no notion of that
	// origin (it only ever talks to the sidecar), so building the URL is
	// the caller's job.
	ExportThread(ctx context.Context, threadID string) (exportID string, err error)

	// ListProviders and SetProviderKey back the settings page
	// (page/settings.go) -- the same DB-backed provider config the desktop
	// app's own settings screen reads and writes.
	ListProviders(ctx context.Context) ([]ProviderStatus, error)
	SetProviderKey(ctx context.Context, provider, name, apiKey string) error

	// WorkspaceTrustStatus reports whether the signed-in user has already
	// granted root -- checked once at Chat startup (page/workspace_trust.go)
	// so the trust prompt can appear before the first message, rather than
	// as a stream of refused tool calls. resolvedRoot is the server's
	// symlink-resolved form of root, shown in the prompt so the user knows
	// exactly what they're being asked to trust.
	WorkspaceTrustStatus(ctx context.Context, root string) (trusted bool, resolvedRoot string, err error)

	// GrantWorkspaceTrust is the human's "yes" answer to the trust prompt.
	GrantWorkspaceTrust(ctx context.Context, root string) error

	// LatestCheckpoint resolves "the most recent turn with checkpoints" for
	// threadID -- what /rewind and Esc-Esc target, since neither names a
	// specific message the way the web dashboard's per-message action does.
	// An empty turnID (with no files) means there is nothing to rewind,
	// rendered as that state explicitly rather than an empty confirmation.
	LatestCheckpoint(ctx context.Context, threadID string) (turnID string, files []CheckpointFile, err error)

	// RestoreCheckpoint reverts every file checkpointed for (threadID,
	// turnID) -- the human's "yes" answer to the rewind confirmation.
	RestoreCheckpoint(ctx context.Context, threadID, turnID string) ([]CheckpointRestoreResult, error)

	// SandboxStatus reports the attached server's detected run_shell
	// sandbox backend -- checked once at Chat startup
	// (page/chat.go's loadSandboxStatus) so the status bar's indicator
	// (docs/coding-agent-parity/03-sandboxed-execution.md) is populated
	// before the first command ever runs, not only after one does.
	SandboxStatus(ctx context.Context) (backend string, sandboxed bool, err error)

	// GitHubStatus, ConnectGitHub and DisconnectGitHub back the settings
	// page's GitHub row (docs/coding-agent-parity/
	// 04-git-remote-operations.md) -- the same presence/status-only
	// contract as the provider-key methods above, over a separate
	// internal/secrets entry with a different blast radius.
	GitHubStatus(ctx context.Context) (connected bool, err error)
	ConnectGitHub(ctx context.Context, token string) error
	DisconnectGitHub(ctx context.Context) error

	// CreateBackgroundJob, ListBackgroundJobs and GetBackgroundJob back
	// `amiro run --background` and the TUI's `/runs` picker
	// (docs/coding-agent-parity/05-background-agent-runs.md). There is
	// deliberately no resume/approve method here -- a suspended job's
	// pending approval is an ordinary data-tool-approval part on its
	// thread, resolved the same way any interactive approval is (open the
	// thread, answer it) rather than through a second resolution path.
	CreateBackgroundJob(ctx context.Context, req CreateBackgroundJobRequest) (BackgroundJob, error)
	ListBackgroundJobs(ctx context.Context) ([]BackgroundJob, error)
	GetBackgroundJob(ctx context.Context, id string) (BackgroundJob, error)
}

// BackgroundJob mirrors backend-go/internal/api/backgroundjob's unexported
// jobResponse.
type BackgroundJob struct {
	ID            string
	ThreadID      string
	WorkspaceRoot string
	Prompt        string
	Mode          string
	Status        string
	AutoPR        bool
	Error         string
	StartedAt     string
	FinishedAt    string
}

// CreateBackgroundJobRequest mirrors the handler's unexported createRequest.
type CreateBackgroundJobRequest struct {
	Prompt        string
	Mode          string
	WorkspaceRoot string
	AutoPR        bool
}

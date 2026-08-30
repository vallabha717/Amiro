package page

import (
	"context"
	"fmt"
	"strings"
	"testing"
	"time"

	tea "github.com/charmbracelet/bubbletea"
	"github.com/charmbracelet/x/exp/golden"

	"amiro/backend/internal/ai/uimessage"
	"amiro/backend/internal/tui/client"
)

// fakeClient is a canned client.Client for page tests -- no HTTP, no
// backend. The golden tests below drive frames directly through Update
// instead of consuming this channel, so its frames are never actually
// needed; it exists so Chat.send has something to call.
//
// lastSend/lastApproval record what Chat actually asked for, so a test can
// assert on the outgoing request (e.g. that a resubmission carries the
// answered part) without needing a real transport underneath.
type fakeClient struct {
	threads   []client.ThreadSummary
	thread    client.ThreadDetail
	models    []client.ProviderModels
	mcp       []client.MCPServer
	workflows []client.Workflow
	skills    client.SkillListResult
	skillsErr error
	providers []client.ProviderStatus

	lastSend        *client.SendMessageRequest
	lastApproval    *client.AssistantResubmission
	deletedThread   string
	exportedThread  string
	exportID        string
	exportErr       error
	lastProviderKey *setProviderKeyCall

	// workspaceUntrusted makes WorkspaceTrustStatus report false, so a test
	// can opt into exercising the trust prompt. Defaulting to trusted (the
	// zero value's opposite -- see WorkspaceTrustStatus below) is what lets
	// every pre-existing test keep passing unmodified: only a test that sets
	// this ever sees the prompt.
	workspaceUntrusted    bool
	grantedWorkspaceTrust string

	// latestCheckpointTurn/latestCheckpointFiles are LatestCheckpoint's
	// canned answer -- empty (the zero value) is "nothing to rewind", which
	// is what lets every pre-existing test keep passing unmodified.
	latestCheckpointTurn  string
	latestCheckpointFiles []client.CheckpointFile
	latestCheckpointErr   error

	// restoredCheckpoint records RestoreCheckpoint's arguments and returns
	// restoreCheckpointResult/Err, so a test can assert on the outgoing
	// request without a real transport underneath.
	restoredCheckpoint      *restoreCheckpointCall
	restoreCheckpointResult []client.CheckpointRestoreResult
	restoreCheckpointErr    error

	// sandboxBackend/sandboxSandboxed are SandboxStatus's canned answer.
	// Empty backend (the zero value) means "not yet resolved" -- the page
	// treats that the same as a Sandbox field never set at all, so every
	// pre-existing test keeps passing unmodified.
	sandboxBackend   string
	sandboxSandboxed bool
	sandboxStatusErr error

	// githubConnected is GitHubStatus's canned answer. lastGitHubToken
	// records what ConnectGitHub was called with, so a test can assert on
	// it without a real internal/secrets store underneath.
	githubConnected      bool
	githubStatusErr      error
	lastGitHubToken      *string
	githubConnectErr     error
	githubDisconnectErr  error
	githubDisconnectedAt bool

	backgroundJobs         []client.BackgroundJob
	createBackgroundJobErr error
	listBackgroundJobsErr  error
}

// restoreCheckpointCall records RestoreCheckpoint's arguments.
type restoreCheckpointCall struct {
	ThreadID, TurnID string
}

// setProviderKeyCall records SetProviderKey's arguments -- fakeClient has
// no real provider store to check afterward.
type setProviderKeyCall struct {
	Provider, Name, APIKey string
}

func (c *fakeClient) SendMessage(_ context.Context, req client.SendMessageRequest) (<-chan uimessage.Frame, func() error) {
	c.lastSend = &req
	ch := make(chan uimessage.Frame)
	close(ch)
	return ch, func() error { return nil }
}

func (c *fakeClient) SubmitApproval(_ context.Context, req client.AssistantResubmission) (<-chan uimessage.Frame, func() error) {
	c.lastApproval = &req
	ch := make(chan uimessage.Frame)
	close(ch)
	return ch, func() error { return nil }
}

func (c *fakeClient) ListThreads(context.Context) ([]client.ThreadSummary, error) {
	return c.threads, nil
}
func (c *fakeClient) GetThread(context.Context, string) (client.ThreadDetail, error) {
	return c.thread, nil
}
func (c *fakeClient) DeleteThread(_ context.Context, id string) error {
	c.deletedThread = id
	return nil
}
func (c *fakeClient) ListModels(context.Context) ([]client.ProviderModels, error) {
	return c.models, nil
}

func (c *fakeClient) ListMCPServers(context.Context) ([]client.MCPServer, error) { return c.mcp, nil }
func (c *fakeClient) ListWorkflows(context.Context) ([]client.Workflow, error) {
	return c.workflows, nil
}

func (c *fakeClient) ListSkills(context.Context, string) (client.SkillListResult, error) {
	if c.skillsErr != nil {
		return client.SkillListResult{}, c.skillsErr
	}
	return c.skills, nil
}

func (c *fakeClient) ExportThread(_ context.Context, threadID string) (string, error) {
	c.exportedThread = threadID
	if c.exportErr != nil {
		return "", c.exportErr
	}
	return c.exportID, nil
}

func (c *fakeClient) ListProviders(context.Context) ([]client.ProviderStatus, error) {
	return c.providers, nil
}

func (c *fakeClient) SetProviderKey(_ context.Context, provider, name, apiKey string) error {
	c.lastProviderKey = &setProviderKeyCall{Provider: provider, Name: name, APIKey: apiKey}
	return nil
}

func (c *fakeClient) WorkspaceTrustStatus(_ context.Context, root string) (bool, string, error) {
	return !c.workspaceUntrusted, root, nil
}

func (c *fakeClient) GrantWorkspaceTrust(_ context.Context, root string) error {
	c.grantedWorkspaceTrust = root
	c.workspaceUntrusted = false
	return nil
}

func (c *fakeClient) LatestCheckpoint(context.Context, string) (string, []client.CheckpointFile, error) {
	if c.latestCheckpointErr != nil {
		return "", nil, c.latestCheckpointErr
	}
	return c.latestCheckpointTurn, c.latestCheckpointFiles, nil
}

func (c *fakeClient) RestoreCheckpoint(_ context.Context, threadID, turnID string) ([]client.CheckpointRestoreResult, error) {
	c.restoredCheckpoint = &restoreCheckpointCall{ThreadID: threadID, TurnID: turnID}
	if c.restoreCheckpointErr != nil {
		return nil, c.restoreCheckpointErr
	}
	return c.restoreCheckpointResult, nil
}

func (c *fakeClient) SandboxStatus(context.Context) (string, bool, error) {
	if c.sandboxStatusErr != nil {
		return "", false, c.sandboxStatusErr
	}
	return c.sandboxBackend, c.sandboxSandboxed, nil
}

func (c *fakeClient) GitHubStatus(context.Context) (bool, error) {
	if c.githubStatusErr != nil {
		return false, c.githubStatusErr
	}
	return c.githubConnected, nil
}

func (c *fakeClient) ConnectGitHub(_ context.Context, token string) error {
	c.lastGitHubToken = &token
	if c.githubConnectErr != nil {
		return c.githubConnectErr
	}
	c.githubConnected = true
	return nil
}

func (c *fakeClient) DisconnectGitHub(context.Context) error {
	c.githubDisconnectedAt = true
	if c.githubDisconnectErr != nil {
		return c.githubDisconnectErr
	}
	c.githubConnected = false
	return nil
}

func (c *fakeClient) CreateBackgroundJob(_ context.Context, req client.CreateBackgroundJobRequest) (client.BackgroundJob, error) {
	if c.createBackgroundJobErr != nil {
		return client.BackgroundJob{}, c.createBackgroundJobErr
	}
	job := client.BackgroundJob{ID: "job-1", Prompt: req.Prompt, Mode: req.Mode, WorkspaceRoot: req.WorkspaceRoot, AutoPR: req.AutoPR, Status: "running"}
	c.backgroundJobs = append(c.backgroundJobs, job)
	return job, nil
}

func (c *fakeClient) ListBackgroundJobs(context.Context) ([]client.BackgroundJob, error) {
	if c.listBackgroundJobsErr != nil {
		return nil, c.listBackgroundJobsErr
	}
	return c.backgroundJobs, nil
}

func (c *fakeClient) GetBackgroundJob(_ context.Context, id string) (client.BackgroundJob, error) {
	for _, j := range c.backgroundJobs {
		if j.ID == id {
			return j, nil
		}
	}
	return client.BackgroundJob{}, fmt.Errorf("job %s not found", id)
}

var _ client.Client = (*fakeClient)(nil)

// fakeClock lets a test control what Chat's "now" is, deterministically --
// goldens can't depend on how fast the test happened to run. advance moves
// it forward, simulating the tickMsg ticks a real streaming turn would
// have gotten.
type fakeClock struct{ t time.Time }

func newFakeClock() *fakeClock {
	return &fakeClock{t: time.Date(2026, 8, 18, 12, 0, 0, 0, time.UTC)}
}

func (c *fakeClock) now() time.Time          { return c.t }
func (c *fakeClock) advance(d time.Duration) { c.t = c.t.Add(d) }

// newGoldenChat builds a Chat with deterministic thread id, workspace and
// clock -- all three appear in the rendered output (thread id and
// workspace in the header, the clock in the status bar's elapsed field),
// and none may vary between test runs.
func newGoldenChat(width, height int) (Chat, *fakeClock) {
	m := NewChat(&fakeClient{}, "thread-golden-0001", "/home/user/project")
	clock := newFakeClock()
	m.now = clock.now
	m, _ = m.Update(tea.WindowSizeMsg{Width: width, Height: height})
	return m, clock
}

// goldenTurnFrames is one representative streamed reply: a run of
// TextDelta frames long enough that 80 and 120 columns wrap it differently,
// which is the whole point of golden-testing two widths instead of one.
var goldenTurnFrames = []uimessage.Frame{
	{Type: uimessage.FrameStart, MessageID: "asst-1"},
	{Type: uimessage.FrameStartStep},
	{Type: uimessage.FrameTextStart, ID: "text-1"},
	{Type: uimessage.FrameTextDelta, ID: "text-1", Delta: "This repository has "},
	{Type: uimessage.FrameTextDelta, ID: "text-1", Delta: "42 Go files across 12 packages, plus a Next.js "},
	{Type: uimessage.FrameTextDelta, ID: "text-1", Delta: "frontend under src/ and a Tauri desktop shell under src-tauri/."},
	{Type: uimessage.FrameTextEnd, ID: "text-1"},
	{Type: uimessage.FrameFinishStep},
	{Type: uimessage.FrameFinish},
	{Type: uimessage.FrameDone},
}

// TestChat_Golden_MidStream is the Phase 1 TUI gate's "chat page golden at
// 80 and 120 cols": the transcript, composer and status line while a reply
// is still streaming in, at both widths.
func TestChat_Golden_MidStream(t *testing.T) {
	for _, width := range []int{80, 120} {
		t.Run(fmt.Sprintf("width_%d", width), func(t *testing.T) {
			m, clock := newGoldenChat(width, 24)
			m.input.SetValue("how is this repo organized?")
			m, _ = m.send()
			clock.advance(3 * time.Second)

			// Through the first two deltas only -- still streaming.
			for _, f := range goldenTurnFrames[:4] {
				m, _ = m.Update(frameMsg(f))
			}

			golden.RequireEqual(t, []byte(m.View()))
		})
	}
}

// TestChat_Golden_Finished is the same turn, complete: [DONE] arrived, the
// composer is idle and ready for the next message.
func TestChat_Golden_Finished(t *testing.T) {
	for _, width := range []int{80, 120} {
		t.Run(fmt.Sprintf("width_%d", width), func(t *testing.T) {
			m, clock := newGoldenChat(width, 24)
			m.input.SetValue("how is this repo organized?")
			m, _ = m.send()
			clock.advance(4 * time.Second)

			for _, f := range goldenTurnFrames {
				m, _ = m.Update(frameMsg(f))
			}
			m, _ = m.Update(streamEndMsg{})

			golden.RequireEqual(t, []byte(m.View()))
		})
	}
}

// TestChat_Golden_Interrupted covers Ctrl+C mid-stream: the transcript
// keeps whatever text already arrived, streaming stops, and the status
// line reads as idle again -- at both widths, since the status bar's
// width-dependent field-dropping is part of what a golden here should
// catch.
func TestChat_Golden_Interrupted(t *testing.T) {
	for _, width := range []int{80, 120} {
		t.Run(fmt.Sprintf("width_%d", width), func(t *testing.T) {
			m, clock := newGoldenChat(width, 24)
			m.input.SetValue("run the test suite")
			m, _ = m.send()
			clock.advance(2 * time.Second)

			for _, f := range goldenTurnFrames[:4] {
				m, _ = m.Update(frameMsg(f))
			}
			m, _ = m.Update(tea.KeyMsg{Type: tea.KeyCtrlC})

			golden.RequireEqual(t, []byte(m.View()))
		})
	}
}

func TestChat_Golden_SlashPalette(t *testing.T) {
	for _, width := range []int{80, 120} {
		t.Run(fmt.Sprintf("width_%d", width), func(t *testing.T) {
			m, _ := newGoldenChat(width, 24)
			m.input.SetValue("/")
			golden.RequireEqual(t, []byte(m.View()))
		})
	}
}

// toolTurnFrames is a "read 3 files, edit 1, run tests" turn -- the exact
// scenario the plan's Phase 2 exit table names for the manual smoke test
// ("Run 'read 3 files, edit 1, run tests' in both surfaces; compare"),
// replayed here as a golden instead: three read_file cards, a todo list
// update, an edit_file card with a real diff, a run_shell card, then the
// closing text -- everything Phase 2 added, in the shape a real turn
// actually produces them.
var toolTurnFrames = []uimessage.Frame{
	{Type: uimessage.FrameStart, MessageID: "asst-1"},
	{Type: uimessage.FrameStartStep},
	{Type: uimessage.FrameReasoningStart, ID: "r1"},
	{Type: uimessage.FrameReasoningDelta, ID: "r1", Delta: "I'll read the three files, then fix the bug and run the tests."},
	{Type: uimessage.FrameReasoningEnd, ID: "r1"},
	{Type: uimessage.FrameToolInputStart, ToolCallID: "call-1", ToolName: "read_file"},
	{Type: uimessage.FrameToolInputAvailable, ToolCallID: "call-1", ToolName: "read_file", Input: []byte(`{"path":"internal/tui/session/state.go"}`)},
	{Type: uimessage.FrameToolOutputAvailable, ToolCallID: "call-1", Output: []byte(`{"path":"internal/tui/session/state.go","total_lines":120}`)},
	{Type: uimessage.FrameToolInputStart, ToolCallID: "call-2", ToolName: "read_file"},
	{Type: uimessage.FrameToolInputAvailable, ToolCallID: "call-2", ToolName: "read_file", Input: []byte(`{"path":"internal/tui/session/reduce.go"}`)},
	{Type: uimessage.FrameToolOutputAvailable, ToolCallID: "call-2", Output: []byte(`{"path":"internal/tui/session/reduce.go","total_lines":200}`)},
	{Type: uimessage.FrameToolInputStart, ToolCallID: "call-3", ToolName: "read_file"},
	{Type: uimessage.FrameToolInputAvailable, ToolCallID: "call-3", ToolName: "read_file", Input: []byte(`{"path":"internal/tui/session/reduce_test.go"}`)},
	{Type: uimessage.FrameToolOutputAvailable, ToolCallID: "call-3", Output: []byte(`{"path":"internal/tui/session/reduce_test.go","total_lines":300}`)},
	{Type: uimessage.FrameFinishStep},

	{Type: uimessage.FrameStartStep},
	{Type: uimessage.FrameToolInputStart, ToolCallID: "call-4", ToolName: "todo_write"},
	{Type: uimessage.FrameToolInputAvailable, ToolCallID: "call-4", ToolName: "todo_write"},
	{
		Type:       uimessage.FrameToolOutputAvailable,
		ToolCallID: "call-4",
		Output:     []byte(`{"items":[{"content":"fix the off-by-one in Reduce","status":"in_progress"},{"content":"run the test suite","status":"pending"}]}`),
	},
	{Type: uimessage.FrameFinishStep},

	{Type: uimessage.FrameStartStep},
	{Type: uimessage.FrameToolInputStart, ToolCallID: "call-5", ToolName: "edit_file"},
	{Type: uimessage.FrameToolInputAvailable, ToolCallID: "call-5", ToolName: "edit_file", Input: []byte(`{"path":"internal/tui/session/reduce.go"}`)},
	{
		Type:       uimessage.FrameToolOutputAvailable,
		ToolCallID: "call-5",
		Output: []byte(`{"path":"internal/tui/session/reduce.go","added":1,"removed":1,` +
			`"edits":[{"added":1,"removed":1,"at_line":88,"hunk":["-idx := s.openTool[id]","+idx, ok := s.openTool[id]"]}]}`),
	},
	{Type: uimessage.FrameFinishStep},

	{Type: uimessage.FrameStartStep},
	{Type: uimessage.FrameToolInputStart, ToolCallID: "call-6", ToolName: "run_shell"},
	{Type: uimessage.FrameToolInputAvailable, ToolCallID: "call-6", ToolName: "run_shell", Input: []byte(`{"command":"go test ./internal/tui/..."}`)},
	{
		Type:       uimessage.FrameToolOutputAvailable,
		ToolCallID: "call-6",
		Output:     []byte(`{"command":"go test ./internal/tui/...","exit_code":0,"output":"ok  \tamiro/backend/internal/tui/session\t0.006s\n"}`),
	},
	{Type: uimessage.FrameFinishStep},

	{Type: uimessage.FrameStartStep},
	{Type: uimessage.FrameTextStart, ID: "text-1"},
	{Type: uimessage.FrameTextDelta, ID: "text-1", Delta: "Fixed the bug and all tests pass."},
	{Type: uimessage.FrameTextEnd, ID: "text-1"},
	{Type: uimessage.FrameFinishStep},
	{Type: uimessage.FrameFinish, MessageMetadata: []byte(
		`{"usage":{"PromptTokens":4200,"CompletionTokens":180,"TotalTokens":4380},"chatModel":{"provider":"anthropic","model":"claude-sonnet-5"},"durationMs":6100}`,
	)},
	{Type: uimessage.FrameDone},
}

// TestChat_Golden_ToolTurn is the Phase 2 TUI gate's tool-card golden: the
// "read 3 files, edit 1, run tests" scenario end to end -- reasoning, three
// file cards, a live todo panel, a diff card, a shell card, the model's
// closing reply, and a status bar with real tokens/cost/elapsed once it's
// done.
func TestChat_Golden_ToolTurn(t *testing.T) {
	for _, width := range []int{80, 120} {
		t.Run(fmt.Sprintf("width_%d", width), func(t *testing.T) {
			m, clock := newGoldenChat(width, 40)
			m.input.SetValue("read state.go, reduce.go and reduce_test.go, fix the bug, run the tests")
			m, _ = m.send()
			clock.advance(6 * time.Second)

			for _, f := range toolTurnFrames {
				m, _ = m.Update(frameMsg(f))
			}
			m, _ = m.Update(streamEndMsg{})

			golden.RequireEqual(t, []byte(m.View()))
		})
	}
}

// TestChat_Golden_ToolTurn_MidRun snapshots the same turn partway through
// -- the third read_file card still pending, the todo panel already live
// -- the state a real interrupt-mid-tool keypress would land on.
func TestChat_Golden_ToolTurn_MidRun(t *testing.T) {
	for _, width := range []int{80, 120} {
		t.Run(fmt.Sprintf("width_%d", width), func(t *testing.T) {
			m, clock := newGoldenChat(width, 40)
			m.input.SetValue("read state.go, reduce.go and reduce_test.go, fix the bug, run the tests")
			m, _ = m.send()
			clock.advance(1 * time.Second)

			// Through call-3's ToolInputAvailable -- pending, no output yet.
			for _, f := range toolTurnFrames[:13] {
				m, _ = m.Update(frameMsg(f))
			}

			golden.RequireEqual(t, []byte(m.View()))
		})
	}
}

// TestChat_Golden_ToolTurn_InterruptedMidTool is the Phase 2 TUI gate's
// "interrupt-mid-tool test" at the page level (internal/tui/session has
// the reduce-level equivalent): Ctrl+C while call-3's read_file is still
// pending must render it as interrupted, not stuck on "running…" forever.
func TestChat_Golden_ToolTurn_InterruptedMidTool(t *testing.T) {
	for _, width := range []int{80, 120} {
		t.Run(fmt.Sprintf("width_%d", width), func(t *testing.T) {
			m, clock := newGoldenChat(width, 40)
			m.input.SetValue("read state.go, reduce.go and reduce_test.go, fix the bug, run the tests")
			m, _ = m.send()
			clock.advance(1 * time.Second)

			for _, f := range toolTurnFrames[:13] {
				m, _ = m.Update(frameMsg(f))
			}
			m, _ = m.Update(tea.KeyMsg{Type: tea.KeyCtrlC})

			golden.RequireEqual(t, []byte(m.View()))
		})
	}
}

// TestChat_ElapsedTicksWhileStreaming is a plain (non-golden) assertion
// that the status bar's elapsed field actually advances with the clock and
// a tickMsg, and freezes once the turn ends -- the behavior the golden
// tests' fixed clock.advance calls stand in for, checked directly rather
// than by eye in a golden diff.
func TestChat_ElapsedTicksWhileStreaming(t *testing.T) {
	m, clock := newGoldenChat(100, 24)
	m.input.SetValue("hi")
	m, cmd := m.send()
	if cmd == nil {
		t.Fatal("send() returned a nil cmd, want tea.Batch(waitForFrame, tickCmd)")
	}

	if got := m.elapsed(); got != 0 {
		t.Fatalf("elapsed() = %v immediately after send, want 0", got)
	}

	clock.advance(5 * time.Second)
	if got, want := m.elapsed(), 5*time.Second; got != want {
		t.Fatalf("elapsed() = %v, want %v", got, want)
	}

	clock.advance(10 * time.Second)
	m, _ = m.Update(streamEndMsg{})
	if got, want := m.elapsed(), 15*time.Second; got != want {
		t.Fatalf("elapsed() after streamEndMsg = %v, want %v (frozen)", got, want)
	}

	// The clock moving further must not change the frozen value -- proof
	// elapsed() is reading elapsedFrozen now, not still computing
	// now().Sub(sendStartedAt).
	clock.advance(100 * time.Second)
	if got, want := m.elapsed(), 15*time.Second; got != want {
		t.Fatalf("elapsed() after the clock advanced post-finish = %v, want %v (still frozen)", got, want)
	}
}

func TestChat_SkillSelection_AttachesMentionAndClears(t *testing.T) {
	fc := &fakeClient{
		skills: client.SkillListResult{
			Items: []client.SkillSummary{
				{Name: "my-skill", Description: "custom skill", Source: ".agents", Scope: "project"},
			},
		},
	}
	m := NewChat(fc, "thread-1", "/workspace")
	m, _ = m.Update(tea.WindowSizeMsg{Width: 100, Height: 24})

	// Load skills
	m, _ = m.Update(skillsLoadedMsg{result: fc.skills})

	// Type "/my" and hit Tab to accept skill
	m.input.SetValue("/my")
	m, _ = m.Update(tea.KeyMsg{Type: tea.KeyTab})

	// Input should be cleared and pendingSkill should be set
	if m.input.Value() != "" {
		t.Fatalf("composer value = %q, want empty after accepting skill", m.input.Value())
	}
	if m.pendingSkill != "my-skill" {
		t.Fatalf("pendingSkill = %q, want 'my-skill'", m.pendingSkill)
	}

	// Status bar should render "skill:my-skill"
	view := m.View()
	if !strings.Contains(view, "skill:my-skill") {
		t.Fatalf("View() does not show skill in status bar:\n%s", view)
	}

	// Type prompt and send
	m.input.SetValue("please execute the task")
	m, _ = m.send()

	if fc.lastSend == nil {
		t.Fatal("SendMessage was not called")
	}
	if len(fc.lastSend.Mentions) != 1 || fc.lastSend.Mentions[0].Type != "skill" || fc.lastSend.Mentions[0].Name != "my-skill" {
		t.Fatalf("lastSend.Mentions = %+v, want [{Type: \"skill\", Name: \"my-skill\"}]", fc.lastSend.Mentions)
	}

	// Pending skill should be cleared after turn is sent
	if m.pendingSkill != "" {
		t.Fatalf("pendingSkill after send = %q, want empty", m.pendingSkill)
	}
}

func TestChat_SkillSelection_ViaEnterDirectly(t *testing.T) {
	fc := &fakeClient{
		skills: client.SkillListResult{
			Items: []client.SkillSummary{
				{Name: "summarize", Description: "summarize skill", Source: ".agents", Scope: "project"},
			},
		},
	}
	m := NewChat(fc, "thread-1", "/workspace")
	m, _ = m.Update(tea.WindowSizeMsg{Width: 100, Height: 24})
	m, _ = m.Update(skillsLoadedMsg{result: fc.skills})

	// User types "/summarize" and presses enter
	m.input.SetValue("/summarize")
	m, _ = m.send()

	if m.pendingSkill != "summarize" {
		t.Fatalf("pendingSkill = %q, want 'summarize'", m.pendingSkill)
	}
	if m.state.Err != nil {
		t.Fatalf("state.Err = %v, want nil", m.state.Err)
	}
}

func TestChat_SkillReservation_ExportSkillReachableOnlyAsSkillExport(t *testing.T) {
	fc := &fakeClient{
		skills: client.SkillListResult{
			Items: []client.SkillSummary{
				{Name: "export", Description: "shadowed user export skill", Source: ".claude", Scope: "user"},
			},
		},
	}
	m := NewChat(fc, "thread-1", "/workspace")
	m, _ = m.Update(tea.WindowSizeMsg{Width: 100, Height: 24})
	m, _ = m.Update(skillsLoadedMsg{result: fc.skills})

	// Built-in /export must invoke exportCurrentThread, not set pendingSkill
	m.input.SetValue("/export")
	m, cmd := m.send()
	if cmd == nil {
		t.Fatal("expected export cmd, got nil")
	}
	if m.pendingSkill != "" {
		t.Fatalf("pendingSkill = %q, want empty (built-in export should not set pendingSkill)", m.pendingSkill)
	}

	// /skill:export sets pendingSkill="export"
	m.input.SetValue("/skill:export")
	m, _ = m.send()
	if m.pendingSkill != "export" {
		t.Fatalf("pendingSkill = %q, want 'export' after typing /skill:export", m.pendingSkill)
	}
}

func TestChat_SlashSkillsNotice_FormatsDiscoveredAndSkipped(t *testing.T) {
	fc := &fakeClient{
		skills: client.SkillListResult{
			Items: []client.SkillSummary{
				{
					Name:        "skill-one",
					Description: "first skill",
					Source:      ".agents",
					Scope:       "project",
					Shadows: []client.ShadowedSkill{
						{Name: "skill-one", Source: ".claude", Scope: "user", Reason: "precedence: project .agents beats user .claude"},
					},
				},
			},
			Diagnostics: []client.SkillDiagnostic{
				{Path: "~/.claude/skills/bad", Message: "invalid YAML"},
			},
		},
	}
	m := NewChat(fc, "thread-1", "/workspace")
	m, _ = m.Update(tea.WindowSizeMsg{Width: 100, Height: 24})
	m, _ = m.Update(skillsLoadedMsg{result: fc.skills})

	m.input.SetValue("/skills")
	m, _ = m.send()

	if m.state.Err != nil {
		t.Fatalf("state.Err = %v, want nil", m.state.Err)
	}
	if !strings.Contains(m.notice, "skill-one (.agents, project)") {
		t.Errorf("notice missing skill-one: %q", m.notice)
	}
	if !strings.Contains(m.notice, "skipped (2):") {
		t.Errorf("notice missing skipped count: %q", m.notice)
	}
}

func TestChat_SkillsFetchFailure_DegradesIndependently(t *testing.T) {
	fc := &fakeClient{
		skillsErr: fmt.Errorf("network connection refused"),
	}
	m := NewChat(fc, "thread-1", "/workspace")
	m, _ = m.Update(tea.WindowSizeMsg{Width: 100, Height: 24})
	m, _ = m.Update(skillsLoadedMsg{err: fc.skillsErr})

	// /mode should still work
	m.input.SetValue("/mode auto")
	m, _ = m.send()
	if m.state.PermissionMode != "auto" {
		t.Fatalf("PermissionMode = %q, want 'auto'", m.state.PermissionMode)
	}
	if m.state.Err != nil {
		t.Fatalf("state.Err = %v, want nil", m.state.Err)
	}
}

func TestChat_DuplicateInvokeNames_DedupesDeterministically(t *testing.T) {
	fc := &fakeClient{
		skills: client.SkillListResult{
			Items: []client.SkillSummary{
				// Higher precedence item: shadowed export skill -> Invoke="skill:export"
				{Name: "export", Description: "project export skill", Source: ".agents", Scope: "project"},
				// Lower precedence item: literal name skill:export -> Invoke="skill:export"
				{Name: "skill:export", Description: "colliding literal skill", Source: ".claude", Scope: "user"},
			},
		},
	}
	m := NewChat(fc, "thread-1", "/workspace")
	m, _ = m.Update(tea.WindowSizeMsg{Width: 100, Height: 24})
	m, _ = m.Update(skillsLoadedMsg{result: fc.skills})

	// Exactly 1 skill command should be registered in m.skillCommands
	if len(m.skillCommands) != 1 {
		t.Fatalf("len(skillCommands) = %d, want 1", len(m.skillCommands))
	}
	if m.skillCommands[0].Description != "project export skill" {
		t.Errorf("skillCommands[0] = %+v, want first item to win", m.skillCommands[0])
	}
	if len(m.skillLookup) != 1 {
		t.Fatalf("len(skillLookup) = %d, want 1", len(m.skillLookup))
	}
}

// TestChat_LoadSandboxStatus_PopulatesStatusBar is this phase's page-level
// coverage: loadSandboxStatus's result reaches Chat.sandbox, and from there
// the status bar's rendering -- the actual wiring exit criterion 4's golden
// test (in internal/tui/component/status) assumes exists upstream.
func TestChat_LoadSandboxStatus_PopulatesStatusBar(t *testing.T) {
	fc := &fakeClient{sandboxBackend: "bubblewrap", sandboxSandboxed: true}
	m := NewChat(fc, "thread-sandbox-status", "/repo")
	m.width, m.height = 120, 20
	m.ready = true

	msg := m.loadSandboxStatus()
	updated, _ := m.Update(msg)

	if updated.sandbox != "bubblewrap" {
		t.Fatalf("Chat.sandbox = %q, want %q", updated.sandbox, "bubblewrap")
	}
	if bar := updated.statusBar(); !strings.Contains(bar, "sandbox:bubblewrap") {
		t.Fatalf("statusBar() = %q, want it to contain the sandbox indicator", bar)
	}
}

// TestChat_LoadSandboxStatus_ErrorLeavesFieldUnset pins the degrade-quietly
// contract: a failed status call (older server, request error) must not
// show a wrong value, so the field stays empty and the status bar renders
// no sandbox indicator at all.
func TestChat_LoadSandboxStatus_ErrorLeavesFieldUnset(t *testing.T) {
	fc := &fakeClient{sandboxStatusErr: fmt.Errorf("boom")}
	m := NewChat(fc, "thread-sandbox-status-err", "/repo")
	m.width, m.height = 120, 20
	m.ready = true

	msg := m.loadSandboxStatus()
	updated, _ := m.Update(msg)

	if updated.sandbox != "" {
		t.Fatalf("Chat.sandbox = %q, want empty after a failed status call", updated.sandbox)
	}
	if bar := updated.statusBar(); strings.Contains(bar, "sandbox:") {
		t.Fatalf("statusBar() = %q, want no sandbox field after a failed status call", bar)
	}
}

// Package page holds the TUI's screens. Phase 1 shipped exactly one: Chat.
// Phase 2 grows it from plain text into tool cards, reasoning blocks, a
// todo panel and a live status bar, but the page itself is still the same
// one screen -- see docs/tui-progress.md's Phase 1 entry for why app/page
// stayed this thin rather than following the plan's fuller component/
// split up front.
package page

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"time"

	"github.com/charmbracelet/bubbles/key"
	"github.com/charmbracelet/bubbles/textarea"
	"github.com/charmbracelet/bubbles/viewport"
	tea "github.com/charmbracelet/bubbletea"
	"github.com/charmbracelet/lipgloss"
	"github.com/google/uuid"

	"amiro/backend/internal/ai/uimessage"
	"amiro/backend/internal/tui/client"
	"amiro/backend/internal/tui/component/approval"
	"amiro/backend/internal/tui/component/editor"
	"amiro/backend/internal/tui/component/status"
	"amiro/backend/internal/tui/component/todo"
	"amiro/backend/internal/tui/component/toolcard"
	"amiro/backend/internal/tui/keys"
	"amiro/backend/internal/tui/session"
	"amiro/backend/internal/tui/theme"
)

// headerLines and statusLines are the chrome rows that always exist. The
// todo panel is the one variable-height row -- 0 or 1 line, see
// chromeHeight -- everything else is a fixed budget. The approval dialog is
// deliberately not one of these: it renders inside the scrollable
// transcript (render's job), not as fixed chrome, because its height
// varies with the call's input -- see renderPendingApproval.
const (
	headerLines = 1
	statusLines = 1
	inputHeight = 3
)

// tickInterval is how often the status bar's elapsed clock advances while
// a turn is streaming.
const tickInterval = time.Second

// defaultMode is what the status bar and every outgoing request show before
// any /mode command has run, matching permission.ParseMode's own fallback
// for an empty string -- interactive, not permissive.
const defaultMode = "interactive"

// frameMsg is one decoded frame arriving off the current turn's stream.
type frameMsg uimessage.Frame

// streamEndMsg reports how the current turn's stream ended: nil for a clean
// [DONE], the transport error otherwise. A context.Canceled here is the
// interrupt path completing, not a failure -- Update treats it as one.
type streamEndMsg struct{ err error }

// tickMsg advances the status bar's elapsed clock. Re-issued by Update as
// long as a turn is streaming; letting it lapse (not rescheduling) is how
// the clock stops without a separate "cancel the ticker" message.
type tickMsg time.Time

// waitForFrame reads exactly one value off frames as a tea.Cmd -- the only
// way to bridge a channel into Bubble Tea's event loop without blocking
// Update, which must never block (plan §2.7). Chat re-issues this after
// every frameMsg it handles, so the stream is read one frame per Bubble Tea
// tick rather than draining the channel inside Update.
func waitForFrame(frames <-chan uimessage.Frame, wait func() error) tea.Cmd {
	return func() tea.Msg {
		f, ok := <-frames
		if !ok {
			return streamEndMsg{err: wait()}
		}
		return frameMsg(f)
	}
}

func tickCmd() tea.Cmd {
	return tea.Tick(tickInterval, func(t time.Time) tea.Msg { return tickMsg(t) })
}

// Chat is the walking skeleton's one page: a transcript and a composer, one
// open thread, streaming text, tool cards, reasoning and a todo panel in
// from a Client.
type Chat struct {
	c             client.Client
	state         *session.State
	workspaceRoot string

	// dashboardURL is set only by `amiro --serve`, which runs the TUI and
	// a browser-reachable dashboard off one embedded backend.
	dashboardURL string

	viewport viewport.Model
	input    textarea.Model
	ready    bool
	width    int
	height   int

	sending bool
	cancel  context.CancelFunc
	frames  <-chan uimessage.Frame
	wait    func() error

	// chatModel pins every future turn to a specific provider/model, once
	// the model picker has chosen one -- nil (the server's default) until
	// then.
	chatModel *client.ChatModel

	// mentionCandidates is every @-mentionable thing (fetched once at
	// startup, loadMentionables) the composer completes against.
	// pendingMentions accumulates as the user accepts completions
	// (acceptMentionSuggestion) and is attached to the next SendMessage,
	// then cleared -- see component/editor/mention.go's doc comment for why
	// resolution works this way instead of re-parsing the composer's text.
	mentionCandidates []editor.Mentionable
	pendingMentions   []client.Mention

	// notice is a one-line, non-error status set by a slash command that
	// completes asynchronously (/export) -- rendered like state.Err's line
	// but in System's tone, not Error's, and cleared the next time the user
	// sends anything.
	notice string

	// now is time.Now, overridden in tests so elapsed-time rendering is
	// deterministic -- see chat_test.go's fakeClock.
	now           func() time.Time
	sendStartedAt time.Time
	elapsedFrozen time.Duration
}

// NewChat starts a page over an empty thread. threadID is minted by the
// caller (cmd/amiro) once per run -- RunTurn creates it server-side on the
// first message, so the page never has to ask whether it already exists.
func NewChat(c client.Client, threadID, workspaceRoot string) Chat {
	input := textarea.New()
	input.Placeholder = "Ask Amiro…"
	input.Prompt = "> "
	input.ShowLineNumbers = false
	input.CharLimit = 0
	input.SetHeight(inputHeight)
	input.Focus()

	return Chat{
		c:             c,
		state:         session.New(threadID),
		workspaceRoot: workspaceRoot,
		input:         input,
		now:           time.Now,
	}
}

func (m Chat) Init() tea.Cmd {
	return tea.Batch(textarea.Blink, m.loadMentionables)
}

func (m Chat) Update(msg tea.Msg) (Chat, tea.Cmd) {
	switch msg := msg.(type) {
	case tea.WindowSizeMsg:
		return m.resize(msg.Width, msg.Height), nil

	case tea.KeyMsg:
		// The approval dialog owns every keypress while it's open -- the
		// plan renders it "as though it were blocking" (§2.4), and the turn
		// really is suspended server-side until y/a/n answers it. Nothing
		// else in this switch (Send, the composer, Ctrl+C) should still
		// react while it's up.
		if m.state.PendingApproval != nil {
			return m.updateApproval(msg)
		}

		switch {
		case key.Matches(msg, keys.DefaultChatKeyMap.Interrupt):
			if m.sending {
				return m.interrupt(), nil
			}
			return m, tea.Quit

		case key.Matches(msg, keys.DefaultChatKeyMap.Threads):
			return m, func() tea.Msg { return OpenThreadsMsg{} }

		case key.Matches(msg, keys.DefaultChatKeyMap.Models):
			return m, func() tea.Msg { return OpenModelsMsg{} }

		case key.Matches(msg, keys.DefaultChatKeyMap.Palette):
			// Ctrl+P reaches the same palette typing "/" does -- it primes
			// the composer with the trigger character rather than opening a
			// second, separate list, so there is exactly one place slash
			// completion lives.
			if !m.sending {
				m.input.SetValue("/")
				m.input.CursorEnd()
			}
			return m, nil

		case key.Matches(msg, keys.DefaultChatKeyMap.Send) && !m.sending:
			return m.send()

		case msg.Type == tea.KeyTab && !m.sending:
			if cmd, ok := m.acceptSlashSuggestion(); ok {
				m.input.SetValue("/" + cmd + " ")
				m.input.CursorEnd()
				return m, nil
			}
			if mention, ok := m.acceptMentionSuggestion(); ok {
				m.input.SetValue(editor.ReplaceLastToken(m.input.Value(), "@"+mention.Name+" "))
				m.input.CursorEnd()
				m.pendingMentions = append(m.pendingMentions, toClientMention(mention))
				return m, nil
			}

		case key.Matches(msg, keys.DefaultChatKeyMap.ScrollUp) || key.Matches(msg, keys.DefaultChatKeyMap.ScrollDn):
			var cmd tea.Cmd
			m.viewport, cmd = m.viewport.Update(msg)
			return m, cmd
		}

	case mentionablesLoadedMsg:
		m.mentionCandidates = msg.candidates
		return m, nil

	case exportedMsg:
		if msg.err != nil {
			m.state.Err = fmt.Errorf("export failed: %w", msg.err)
		} else {
			m.notice = "exported: id=" + msg.id + " (open it from the desktop app, or GET /api/export/" + msg.id + ")"
		}
		return m, nil

	case frameMsg:
		m.state.Reduce(uimessage.Frame(msg))
		m.refreshTranscript()
		return m, waitForFrame(m.frames, m.wait)

	case streamEndMsg:
		m.sending = false
		m.elapsedFrozen = m.now().Sub(m.sendStartedAt)
		if msg.err != nil && !errors.Is(msg.err, context.Canceled) {
			m.state.Failed(msg.err)
		}
		m.refreshTranscript()
		return m, nil

	case tickMsg:
		if m.sending {
			return m, tickCmd()
		}
		return m, nil
	}

	var cmd tea.Cmd
	m.input, cmd = m.input.Update(msg)
	return m, cmd
}

func (m Chat) View() string {
	if !m.ready {
		return "starting amiro…"
	}
	header := theme.Default.System.Render(fmt.Sprintf("amiro · %s · thread %s", m.workspaceRoot, m.state.ThreadID))

	view := header + "\n" + m.viewport.View() + "\n"
	if line := todo.Render(m.width, m.state.Todos); line != "" {
		view += line + "\n"
	}
	view += m.input.View() + "\n"
	if suggestions := m.composerSuggestions(); suggestions != "" {
		view += suggestions + "\n"
	}
	view += m.statusBar()
	return view
}

// composerSuggestions is the completion list under the composer: slash
// commands while it reads "/<partial command>", @-mentions while its last
// token reads "@<partial name>" -- empty (and so invisible) the rest of the
// time, including mid-turn and while an approval dialog owns the keyboard.
// The two triggers can't both match at once (Suggest requires "/" to start
// the *whole* input; a mention can start anywhere but reads its own last
// token), so checking slash first and falling back to mentions is enough --
// no precedence rule to get wrong.
func (m Chat) composerSuggestions() string {
	if m.sending || m.state.PendingApproval != nil {
		return ""
	}
	width := max(m.width-2, 1)
	if matches := editor.Suggest(m.input.Value()); matches != nil {
		return editor.RenderSuggestions(width, matches, 0)
	}
	if matches := editor.SuggestMentions(m.input.Value(), m.mentionCandidates); matches != nil {
		return editor.RenderMentionSuggestions(width, matches, 0)
	}
	return ""
}

// chromeHeight is every row View draws outside the viewport and the
// composer: the header, the todo panel (0 or 1 line -- absent unless a
// todo_write/todo_read call has actually reported a plan), and the status
// bar. resize and refreshTranscript both call this so the viewport's
// height is never stale relative to what's actually being drawn around it.
func (m Chat) chromeHeight() int {
	h := headerLines + statusLines
	if len(m.state.Todos) > 0 {
		h++
	}
	return h
}

func (m *Chat) resize(width, height int) Chat {
	m.width, m.height = width, height
	if !m.ready {
		m.viewport = viewport.New(width, 1)
		m.ready = true
	}
	m.input.SetWidth(max(width-2, 1))
	m.refreshTranscript()
	return *m
}

func (m *Chat) send() (Chat, tea.Cmd) {
	text := strings.TrimSpace(m.input.Value())
	if text == "" {
		return *m, nil
	}
	m.notice = ""
	if name, args, ok := editor.Parse(text); ok {
		m.input.Reset()
		return m.executeSlashCommand(name, args)
	}
	m.input.Reset()

	msgID := uuid.NewString()
	m.state.SendUserMessage(msgID, text)
	m.sendStartedAt = m.now()

	ctx, cancel := context.WithCancel(context.Background())
	m.cancel = cancel
	m.sending = true

	frames, wait := m.c.SendMessage(ctx, client.SendMessageRequest{
		ThreadID:       m.state.ThreadID,
		MessageID:      msgID,
		Text:           text,
		WorkspaceRoot:  m.workspaceRoot,
		PermissionMode: m.state.PermissionMode,
		ChatModel:      m.chatModel,
		Mentions:       m.pendingMentions,
	})
	m.pendingMentions = nil
	m.frames = frames
	m.wait = wait

	m.refreshTranscript()
	return *m, tea.Batch(waitForFrame(frames, wait), tickCmd())
}

// acceptSlashSuggestion reports the top remaining slash-command match for
// the composer's current text, for Tab to fill in -- Appendix B's "Tab:
// accept completion", scoped to one match rather than a cycled selection,
// since the palette is short enough that the top match is almost always
// the one the user meant.
func (m Chat) acceptSlashSuggestion() (name string, ok bool) {
	matches := editor.Suggest(m.input.Value())
	if len(matches) == 0 {
		return "", false
	}
	return matches[0].Name, true
}

// acceptMentionSuggestion is acceptSlashSuggestion's mirror for "@" --
// same top-match-wins reasoning.
func (m Chat) acceptMentionSuggestion() (editor.Mentionable, bool) {
	matches := editor.SuggestMentions(m.input.Value(), m.mentionCandidates)
	if len(matches) == 0 {
		return editor.Mentionable{}, false
	}
	return matches[0], true
}

// executeSlashCommand runs a "/name args" line the composer would otherwise
// have sent as chat text. Unrecognized names are reported inline rather
// than silently sent to the model as a literal "/frobnicate" message, which
// a model would try to answer as though it were a real question.
func (m *Chat) executeSlashCommand(name, args string) (Chat, tea.Cmd) {
	switch name {
	case "mode":
		mode := strings.TrimSpace(args)
		switch mode {
		case "plan", "interactive", "edit", "auto":
			m.SetMode(mode)
		default:
			m.state.Err = fmt.Errorf("/mode wants one of plan, interactive, edit, auto -- got %q", mode)
		}
		return *m, nil
	case "threads":
		return *m, func() tea.Msg { return OpenThreadsMsg{} }
	case "models":
		return *m, func() tea.Msg { return OpenModelsMsg{} }
	case "settings":
		return *m, func() tea.Msg { return OpenSettingsMsg{} }
	case "compact":
		return m.sendCompactNow()
	case "export":
		return *m, m.exportCurrentThread
	case "help", "":
		m.state.Err = nil
		return *m, nil
	default:
		m.state.Err = fmt.Errorf("unknown command /%s -- try /mode, /threads, /models, /settings, /compact or /export", name)
		return *m, nil
	}
}

// sendCompactNow sends a turn with CompactNow set -- the same send path as
// a normal message, just with a fixed instruction text and the one extra
// request field. A real turn (not a control-plane-only request) because
// RunTurn's compaction check runs inside the tool loop, ahead of the
// model call it's about to make -- there is no "compact with no turn"
// entry point on the server, by design (plan §2.2: the TUI is a client of
// the same rail, not a second implementation).
func (m *Chat) sendCompactNow() (Chat, tea.Cmd) {
	const text = "Compact the conversation history to free up context."
	msgID := uuid.NewString()
	m.state.SendUserMessage(msgID, text)
	m.sendStartedAt = m.now()

	ctx, cancel := context.WithCancel(context.Background())
	m.cancel = cancel
	m.sending = true

	frames, wait := m.c.SendMessage(ctx, client.SendMessageRequest{
		ThreadID:       m.state.ThreadID,
		MessageID:      msgID,
		Text:           text,
		WorkspaceRoot:  m.workspaceRoot,
		PermissionMode: m.state.PermissionMode,
		ChatModel:      m.chatModel,
		CompactNow:     true,
	})
	m.frames = frames
	m.wait = wait

	m.refreshTranscript()
	return *m, tea.Batch(waitForFrame(frames, wait), tickCmd())
}

// exportedMsg carries /export's result -- ExportThread is a network call
// and must run as a tea.Cmd, never inline in Update (plan §2.7: Update must
// never block).
type exportedMsg struct {
	id  string
	err error
}

func (m Chat) exportCurrentThread() tea.Msg {
	id, err := m.c.ExportThread(context.Background(), m.state.ThreadID)
	return exportedMsg{id: id, err: err}
}

// State exposes the open thread's session state, read-only in spirit
// (nothing outside this package should mutate it) -- app.Model reads
// ThreadID off it after a resume, and a test can assert on it directly
// rather than through View()'s rendered text.
func (m Chat) State() *session.State {
	return m.state
}

// SetDashboardURL surfaces `amiro --serve`'s dashboard address in the
// status bar. Applied once at startup, like SetMode and SetModel.
func (m *Chat) SetDashboardURL(url string) { m.dashboardURL = url }

// SetMode changes the permission mode every future turn is sent with --
// the desktop app's equivalent setting, applied through the same request
// field (chatapi.chatRequest.PermissionMode) rather than a second
// mechanism.
func (m *Chat) SetMode(mode string) {
	m.state.PermissionMode = mode
}

// SetModel pins every future turn to provider/model -- the model picker's
// result.
func (m *Chat) SetModel(provider, model string) {
	m.chatModel = &client.ChatModel{Provider: provider, Model: model}
}

// LoadThread replaces the open thread with detail's persisted history --
// the thread switcher's resume path. The transcript renders it through the
// same session.State/renderParts path a live turn uses; only the data
// arrived by a different route (a fetched thread instead of a frame
// stream).
func (m *Chat) LoadThread(detail client.ThreadDetail) {
	persisted := make([]session.PersistedMessage, len(detail.Messages))
	for i, msg := range detail.Messages {
		persisted[i] = session.PersistedMessage{ID: msg.ID, Role: msg.Role, Parts: msg.Parts, Metadata: msg.Metadata}
	}
	m.state = session.ReplayThread(detail.ID, persisted)
	m.sending = false
	m.refreshTranscript()
}

// updateApproval handles a keypress while an approval dialog is open --
// y/a/n only, per keys.DefaultApprovalKeyMap's own doc comment on why there
// is no Esc.
func (m Chat) updateApproval(msg tea.KeyMsg) (Chat, tea.Cmd) {
	switch {
	case key.Matches(msg, keys.DefaultApprovalKeyMap.ApproveOnce):
		return m.answerApproval(true, "once")
	case key.Matches(msg, keys.DefaultApprovalKeyMap.ApproveAlways):
		return m.answerApproval(true, "always")
	case key.Matches(msg, keys.DefaultApprovalKeyMap.Deny):
		return m.answerApproval(false, "")
	}
	return m, nil
}

// answerApproval builds the resubmission (session.State's job -- it knows
// the wire shape) and resends it over client.SubmitApproval, the same
// streaming contract send() uses for a fresh turn.
func (m *Chat) answerApproval(confirm bool, scope string) (Chat, tea.Cmd) {
	id, parts, ok := m.state.BuildApprovalResubmission(confirm, scope)
	if !ok {
		return *m, nil
	}
	m.sendStartedAt = m.now()

	ctx, cancel := context.WithCancel(context.Background())
	m.cancel = cancel
	m.sending = true

	frames, wait := m.c.SubmitApproval(ctx, client.AssistantResubmission{
		ThreadID:       m.state.ThreadID,
		MessageID:      id,
		Parts:          parts,
		WorkspaceRoot:  m.workspaceRoot,
		PermissionMode: m.state.PermissionMode,
	})
	m.frames = frames
	m.wait = wait

	m.refreshTranscript()
	return *m, tea.Batch(waitForFrame(frames, wait), tickCmd())
}

func (m *Chat) interrupt() Chat {
	if m.cancel != nil {
		m.cancel()
	}
	m.elapsedFrozen = m.now().Sub(m.sendStartedAt)
	m.state.Interrupted()
	m.sending = false
	m.refreshTranscript()
	return *m
}

func (m *Chat) refreshTranscript() {
	if !m.ready {
		return
	}
	vpHeight := m.height - m.chromeHeight() - inputHeight
	if vpHeight < 1 {
		vpHeight = 1
	}
	m.viewport.Width = m.width
	m.viewport.Height = vpHeight

	atBottom := m.viewport.AtBottom()
	m.viewport.SetContent(m.render())
	if atBottom {
		m.viewport.GotoBottom()
	}
}

// render is the transcript's projection of session.State: each message's
// Parts in order, text word-wrapped, reasoning styled as an aside, tool
// calls as cards.
func (m Chat) render() string {
	width := max(m.width-2, 1)
	var b strings.Builder
	for i, msg := range m.state.Messages {
		if i > 0 {
			b.WriteString("\n\n")
		}
		label := theme.Default.User.Render("You")
		if msg.Role == session.RoleAssistant {
			label = theme.Default.Assistant.Render("Amiro")
		}
		b.WriteString(label)
		b.WriteString("\n")
		b.WriteString(m.renderParts(msg, width))
	}
	if m.state.Err != nil {
		b.WriteString("\n\n")
		b.WriteString(theme.Default.Error.Render("error: " + m.state.Err.Error()))
	}
	if m.notice != "" {
		b.WriteString("\n\n")
		b.WriteString(theme.Default.System.Render(m.notice))
	}
	if m.state.PendingApproval != nil {
		b.WriteString("\n\n")
		b.WriteString(approval.Render(width, *m.state.PendingApproval, m.pendingApprovalInput()))
	}
	return b.String()
}

// pendingApprovalInput finds the tool call PendingApproval describes and
// returns its raw input -- the dialog renders "what will run" from input
// alone, the same "nothing has run yet" contract the desktop app's
// ToolApprovalCard documents.
func (m Chat) pendingApprovalInput() json.RawMessage {
	req := m.state.PendingApproval
	if req == nil || len(m.state.Messages) == 0 {
		return nil
	}
	last := m.state.Messages[len(m.state.Messages)-1]
	for _, p := range last.Parts {
		if p.Kind == session.PartTool && p.Tool != nil && p.Tool.ID == req.ToolCallID {
			return p.Tool.Input
		}
	}
	return nil
}

func (m Chat) renderParts(msg session.Message, width int) string {
	if len(msg.Parts) == 0 {
		if msg.Role == session.RoleAssistant && m.state.Streaming {
			return theme.Default.Muted.Render("…")
		}
		return ""
	}

	chunks := make([]string, 0, len(msg.Parts))
	for _, p := range msg.Parts {
		switch p.Kind {
		case session.PartText:
			chunks = append(chunks, lipgloss.NewStyle().Width(width).Render(p.Text))
		case session.PartReasoning:
			chunks = append(chunks, theme.Default.Reasoning.Width(width).Render(p.Text))
		case session.PartTool:
			if p.Tool != nil {
				chunks = append(chunks, toolcard.Render(width, *p.Tool))
			}
		}
	}
	return strings.Join(chunks, "\n")
}

func (m Chat) elapsed() time.Duration {
	if m.sending {
		return m.now().Sub(m.sendStartedAt)
	}
	return m.elapsedFrozen
}

func (m Chat) statusBar() string {
	return status.Render(m.width, status.Info{
		Model:         m.state.Model,
		Mode:          m.modeLabel(),
		WorkspaceRoot: m.workspaceRoot,
		Dashboard:     m.dashboardURL,
		Usage:         m.state.Usage,
		Elapsed:       m.elapsed(),
		Streaming:     m.sending,
		Hint:          statusHint(m.sending, m.state.PendingApproval != nil),
	})
}

// modeLabel is what the status bar's Mode field reads -- PermissionMode
// unless it's still the zero value, matching permission.ParseMode's own
// fallback (an empty string reads as interactive, not permissive) so the
// display never claims a mode more restrictive or more permissive than
// what every outgoing request actually carries.
func (m Chat) modeLabel() string {
	if m.state.PermissionMode == "" {
		return defaultMode
	}
	return m.state.PermissionMode
}

func statusHint(sending, awaitingApproval bool) string {
	switch {
	case awaitingApproval:
		return "y approve · a always allow · n deny"
	case sending:
		return "ctrl+c to interrupt"
	default:
		return "enter to send · ctrl+c to quit"
	}
}

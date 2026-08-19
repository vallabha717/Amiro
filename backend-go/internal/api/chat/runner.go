package chat

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"time"

	"gorm.io/datatypes"

	"amiro/backend/internal/agent/permission"
	"amiro/backend/internal/agent/session"
	"amiro/backend/internal/agent/workspace"
	bifrostai "amiro/backend/internal/ai/bifrost"
	"amiro/backend/internal/ai/prompts"
	"amiro/backend/internal/ai/tools"
	"amiro/backend/internal/ai/uimessage"
	"amiro/backend/internal/db/models"
	"amiro/backend/internal/user"
)

// TurnRequest is everything one agent turn needs, with no statement about
// how it arrived.
//
// It is chatRequest plus the authenticated user, which the HTTP handler
// used to read out of the request context. That is the whole difference:
// the browser's wire shape stays in route.go, and this is what the turn
// itself is defined over.
type TurnRequest struct {
	// User is the authenticated caller. Never nil in a live turn -- it
	// decides thread ownership, agent visibility and what the system prompt
	// says about who is asking.
	User *models.User

	// ThreadID is the conversation this turn belongs to. Created on first
	// use if no thread with this id exists.
	ThreadID string

	// Message is the turn's input. A user message starts a turn; an
	// assistant message *continues* one that stopped for an approval --
	// see RunTurn's handling of `continuing`.
	Message uiMessage

	ChatModel                *chatModelDTO
	ToolChoice               string
	Mentions                 []mentionDTO
	AllowedAppDefaultToolkit *[]string
	AllowedMcpServers        map[string]allowedMCPServerDTO

	// PermissionMode is "plan" | "manual" | "edit" | "auto"; anything else
	// reads as interactive (permission.ParseMode).
	PermissionMode string

	// WorkspaceRoot scopes file and shell tools to a directory, falling
	// back to ProjectDir and then to the handler's configured default.
	WorkspaceRoot string
	ProjectDir    string

	// CompactNow forces this turn's history to compact on its first step
	// regardless of size -- the TUI's `/compact` command. False (the zero
	// value) changes nothing: compaction still only triggers automatically,
	// as it always has (compactIfNeeded, WithForceCompact).
	CompactNow bool
}

// TurnResult reports what a turn did, for a caller that is not a stream.
//
// The streaming client already learned all of this from the frames; this is
// for callers that have no client -- the headless runner and the evaluation
// harness -- and for tests, which would otherwise have to parse SSE to
// assert on a turn's outcome.
type TurnResult struct {
	// ResponseID is the assistant message's id: freshly minted for a new
	// turn, or the continued message's own id when an approval resumed one.
	ResponseID string

	// Text is every step's assistant text, in order.
	Text string

	// Steps is how many model turns the loop ran.
	Steps int

	Usage      *bifrostai.Usage
	ToolCount  int
	DurationMS int64

	// Log is the structured record of actions and observations
	// (internal/agent/session). The persisted parts are a projection of it.
	Log *session.Log
}

// ErrForbidden is returned when the caller does not own the thread.
//
// A named error rather than an HTTP status because RunTurn does not know
// what a status code is -- the handler maps it (route.go), and a terminal
// or headless caller prints it.
var ErrForbidden = errors.New("chat: thread belongs to another user")

// ErrInvalidTurn is returned for a turn that cannot be run as described: no
// thread id, no message id.
var ErrInvalidTurn = errors.New("chat: id and message are required")

// NewTextTurn builds a turn from plain text, for callers that are not the
// browser.
//
// The message DTOs stay unexported on purpose: they are the AI SDK's
// UIMessage shape, and a caller outside this package that assembled one by
// hand would be encoding a frontend contract it has no reason to know. A
// headless run has a user, a thread and a sentence; this is that.
func NewTextTurn(u *models.User, threadID, text string) TurnRequest {
	return TurnRequest{
		User:     u,
		ThreadID: threadID,
		Message: uiMessage{
			ID:    models.NewID(),
			Role:  "user",
			Parts: []json.RawMessage{json.RawMessage(textPartJSON(text))},
		},
	}
}

// textPartJSON renders one text part, the only part kind a plain-text turn
// needs.
func textPartJSON(text string) []byte {
	b, err := json.Marshal(map[string]string{"type": "text", "text": text})
	if err != nil {
		// Unreachable: a string always marshals. Returning an empty text
		// part beats panicking in a caller that just wanted to ask a
		// question.
		return []byte(`{"type":"text","text":""}`)
	}
	return b
}

// WithModel selects the provider and model for this turn.
func (t TurnRequest) WithModel(provider, model string) TurnRequest {
	t.ChatModel = &chatModelDTO{Provider: provider, Model: model}
	return t
}

// WithPermissionMode sets how much the agent may do without asking.
func (t TurnRequest) WithPermissionMode(mode string) TurnRequest {
	t.PermissionMode = mode
	return t
}

// WithWorkspace scopes this turn's file and shell tools to root.
func (t TurnRequest) WithWorkspace(root string) TurnRequest {
	t.WorkspaceRoot = root
	return t
}

// RunTurn runs one agent turn: resolve the thread, resolve the model and
// agent, load every mentioned/allowed tool, run the (possibly multi-step,
// tool-calling) reply onto em, and persist both sides.
//
// # Why this is not inside the HTTP handler any more
//
// It was, and everything it does was already independent of HTTP -- the
// body between "decode the request" and "write the response" touched
// neither the ResponseWriter nor the Request. Two callers already wanted
// that body without the transport (the evaluation harness runs the loop
// with a discard writer, and cmd/amiro will run it for a terminal), and
// each was on course to grow its own arrangement of thread lookup, tool
// loading and prompt assembly. Three arrangements of one turn is how two
// surfaces come to disagree about what the agent does.
//
// So: one turn implementation, and the transports become thin. route.go's
// Chat is now decode, authorize, wrap the ResponseWriter in a Writer, call
// this.
//
// # What it promises the caller
//
// Every failure before the first frame is returned as an error and nothing
// is written to em, so a caller can still choose its own failure
// representation (an HTTP status, a terminal message). Once streaming
// starts, failures are written *into* the stream as error frames and the
// turn is still persisted and still returns a TurnResult -- matching the TS
// route, where onFinish runs whether or not the model call succeeded.
func (h *Handler) RunTurn(ctx context.Context, req TurnRequest, em uimessage.Emitter) (TurnResult, error) {
	if req.User == nil {
		return TurnResult{}, ErrForbidden
	}
	if req.ThreadID == "" || req.Message.ID == "" {
		return TurnResult{}, ErrInvalidTurn
	}

	details, err := h.chats.SelectThreadDetails(ctx, req.ThreadID)
	if err != nil {
		return TurnResult{}, fmt.Errorf("chat: load thread: %w", err)
	}
	if details == nil {
		thread := &models.ChatThread{ID: req.ThreadID, Title: "", UserID: req.User.ID}
		if err := h.chats.InsertThread(ctx, thread); err != nil {
			return TurnResult{}, fmt.Errorf("chat: create thread: %w", err)
		}
		details, err = h.chats.SelectThreadDetails(ctx, req.ThreadID)
		if err != nil || details == nil {
			return TurnResult{}, fmt.Errorf("chat: create thread: not readable after insert")
		}
	}
	if details.Thread.UserID != req.User.ID {
		return TurnResult{}, ErrForbidden
	}

	history := details.Messages
	if len(history) > 0 && history[len(history)-1].ID == req.Message.ID {
		history = history[:len(history)-1]
	}

	chatModel := chatModelDTO{}
	if req.ChatModel != nil {
		chatModel = *req.ChatModel
	}
	resolved := bifrostai.Resolve(chatModel.Provider, chatModel.Model)

	// rememberAgentAction (route.ts:176-187): an agent mention's own
	// pre-bound mentions get merged into the request's before any tool
	// loading below, and its instructions feed into the system prompt.
	agent, mentions := h.resolveAgent(ctx, req.User.ID, req.Mentions)
	var agentInfo *prompts.AgentPromptInfo
	agentID := ""
	if agent != nil {
		agentInfo = agent.Info
		agentID = agent.ID
	}

	var activeTools []tools.Definition
	systemExtra := ""
	if isToolCallAllowed(req) {
		mcpResult, mcpErr := h.loadMCPTools(ctx, req.User.ID, mentions, req.AllowedMcpServers)
		if mcpErr == nil {
			activeTools = mergeToolDefinitions(activeTools, mcpResult.Defs)
			systemExtra = h.mcpCustomizationSystemPrompt(ctx, req.User.ID, mcpResult.ToolsByServer, mcpResult.Servers)
		}

		workflowDefs, wfErr := h.loadWorkflowTools(ctx, mentions)
		if wfErr == nil {
			activeTools = mergeToolDefinitions(activeTools, workflowDefs)
		}
	}

	// Resolve active workspace: prioritize user-selected workspace directory if supplied,
	// falling back to handler's configured default workspace.
	activeWS := h.workspace
	targetWS := req.WorkspaceRoot
	if targetWS == "" {
		targetWS = req.ProjectDir
	}
	if targetWS != "" {
		if ws, err := workspace.New(targetWS); err == nil {
			activeWS = ws
		}
	}

	// Run activeAppDefaultTools against the agent-merged mentions, not just
	// req.Mentions -- an agent's own defaultTool mentions (resolveAgent
	// already appended them into `mentions` above) should apply exactly
	// like a manually-typed one, matching how the TS route pushes
	// agent.instructions.mentions into the same `mentions` array
	// loadAppDefaultTools later reads (route.ts:176-187, shared.chat.ts:427).
	reqForDefaults := req
	reqForDefaults.Mentions = mentions
	activeTools = mergeToolDefinitions(activeTools, activeAppDefaultTools(
		reqForDefaults, h.toolDeps(activeWS, details.Thread.ID),
	))

	perms := permission.New(
		permission.ParseMode(req.PermissionMode),
		activeWS,
		permission.DefaultAllowedCommands,
		h.grants.For(details.Thread.ID),
	)

	// The subagent tool is added last, over the tools already loaded: its
	// child gets a read-only subset of whatever this turn actually has, so
	// a turn with no file tools produces no `task` tool either. It is also
	// what keeps recursion out -- `task` is not in the child's subset, so a
	// subagent cannot spawn one.
	//
	// The child runs under the *same* permission engine, not a permissive
	// one. Its tools are all reads so nothing should ever be gated, but a
	// child holding a weaker engine is precisely the shape of a privilege
	// escalation, and the tool subset is one edit away from including
	// something consequential.
	if isToolCallAllowed(req) {
		if task, ok := subagentTool(h.engine, resolved, activeTools, perms); ok {
			activeTools = mergeToolDefinitions(activeTools, []tools.Definition{task})
		}
	}

	// The clock for this round starts here rather than at the top of the
	// turn: everything above is thread lookup and tool loading, and the
	// approved tool below is work the turn should be charged for.
	//
	// Deliberately per-round, so the stretch where the turn sat waiting for
	// a human to read an approval card is not counted. "Worked for 4m" on a
	// turn that spent three of them idle would be a lie about the agent,
	// and the reader is asking about the agent.
	roundStart := time.Now()

	// Resolve anything the user just approved or rejected before the history
	// is built, so the model sees the tool's real result where the browser
	// left a confirmation. This has to run after tool loading (it needs the
	// definitions to execute) and before toEngineMessages, which is why the
	// history is assembled here rather than up with the thread lookup.
	resolveApprovals(ctx, &req.Message, activeTools, perms)

	engineMessages := make([]bifrostai.Message, 0, len(history)+1)
	for _, m := range history {
		engineMessages = append(engineMessages, dbMessageToEngines(m)...)
	}
	engineMessages = append(engineMessages, req.Message.toEngineMessages()...)
	engineMessages = resolveAttachmentURLs(ctx, engineMessages)

	// Workspace notes go into the system prompt, not behind a tool call.
	// A memory the model has to remember to look up is not memory: it will
	// skip the lookup precisely on the turns where it already thinks it
	// knows the answer, which are the turns a stale assumption costs most.
	// memory_read exists for searching past what the injection budget fits.
	//
	// Only when the memory tools were actually loaded this turn. Notes that
	// say "correct this with memory_write" in a turn with no memory_write
	// tool describe a capability the model does not have, and a model told
	// it can fix something it cannot will keep trying.
	notes := ""
	if _, ok := tools.FindByName(activeTools, tools.NameMemoryWrite); ok {
		notes = h.notes.Prompt()
	}

	// The propose-plan-then-approve contract, on the same terms as the notes
	// above: only when the tool it describes is actually offered this turn.
	// Plan mode's whole instruction is "finish by calling propose_plan", and
	// a model told to call a tool it does not have will keep trying and then
	// apologize, which is a worse Plan mode than the one that said nothing.
	planContract := ""
	if _, ok := tools.FindByName(activeTools, tools.NameProposePlan); ok {
		planContract = prompts.BuildPlanContractPrompt(req.PermissionMode)
	}

	system := prompts.MergeSystemPrompt(
		prompts.BuildUserSystemPrompt(req.User, user.ParsePreferences(details.Preferences), agentInfo),
		systemExtra,
		notes,
		planContract,
	)

	// A turn that stopped to ask for approval resumes as a *continuation* of
	// the assistant message it paused in, not as a new one.
	//
	// The browser re-submits with the assistant message last (the AI SDK's
	// submit-tool-result trigger), so `req.Message` here is the turn so far,
	// not a new instruction. Minting a fresh id for the reply then wrote one
	// assistant row per approval, each a superset of the one before: a turn
	// that asked ten times read back as ten assistant messages and ten work
	// logs ("Worked · 9 steps", "· 10 steps", "· 11 steps" ...), all
	// describing the same piece of work. Continuing the same id makes a turn
	// one message however many times it had to stop.
	continuing := req.Message.Role == "assistant"
	responseID := req.Message.ID
	if !continuing {
		responseID = models.NewID()
	}

	_ = em.Start(responseID)

	loopCtx := WithForceCompact(ctx, req.CompactNow)
	loopResult, loopErr := runToolLoop(loopCtx, h.engine, em, resolved, system, engineMessages, activeTools, perms)
	if loopErr != nil {
		_ = em.Error(loopErr.Error())
	}

	// Totals for the whole turn, not for this round. Both are carried on the
	// message the browser sent back, which is where the previous round left
	// them -- there is no server-side turn state to read them from, and a
	// per-round figure would report a ten-approval turn as whatever its last
	// few seconds happened to cost.
	prior := priorMetadata(req.Message, continuing)
	metadata := chatMetadata{
		Usage:      addUsage(prior.Usage, loopResult.Usage),
		ChatModel:  &chatModel,
		ToolChoice: req.ToolChoice,
		ToolCount:  len(activeTools),
		AgentID:    agentID,
		DurationMS: prior.DurationMS + time.Since(roundStart).Milliseconds(),
	}

	result := TurnResult{
		ResponseID: responseID,
		Text:       loopResult.Text,
		Steps:      loopResult.Steps,
		Usage:      metadata.Usage,
		ToolCount:  metadata.ToolCount,
		DurationMS: metadata.DurationMS,
		Log:        loopResult.Log,
	}

	// Persist even if the loop errored partway through -- matches onFinish
	// always running in the TS route (createUIMessageStream calls onFinish
	// regardless of whether the model call itself failed).
	//
	// This runs BEFORE em.Finish/em.Done, and against
	// context.WithoutCancel(ctx), not ctx -- both found the hard way, by a
	// real end-to-end test of internal/tui/client against a real
	// *http.Server (httptest.NewRecorder has no live connection for a
	// client to close, so it never exercised either path):
	//
	//   - Ordering: [DONE] is the signal both surfaces treat as "the turn
	//     is over, safe to act on" -- the TUI reopens the thread, a test
	//     re-fetches it. That was previously false: this code wrote [DONE]
	//     to the stream and *then* persisted, so a client reading the
	//     stream at wire speed (no artificial delay needed) could see
	//     [DONE] and re-fetch the thread before these writes ran, and
	//     legitimately observe zero of them. Persisting first makes
	//     [DONE] mean what a client already assumes it means.
	//   - Context: a client that closes its connection right after [DONE]
	//     -- which the fix above makes irrelevant here, but an interrupt
	//     mid-loopResult (loopErr wrapping ctx.Err()) still leaves ctx
	//     already canceled at this point -- cancels ctx through net/http's
	//     normal plumbing. Persisting the partial turn an interrupt
	//     produced (the guarantee this comment block opens with) requires
	//     a context that surviving that cancellation, which ctx itself no
	//     longer does.
	persistCtx := context.WithoutCancel(ctx)
	metadataJSON, _ := json.Marshal(metadata)

	if continuing {
		// One write, because the row being continued and the row being
		// written are the same row. req.Message.Parts is the turn up to the
		// pause with the approval already resolved in place by
		// resolveApprovals, so this stores the answered call rather than the
		// question a reloaded thread would otherwise re-ask.
		_ = h.chats.UpsertMessage(persistCtx, &models.ChatMessage{
			ID:       responseID,
			ThreadID: details.Thread.ID,
			Role:     "assistant",
			Parts:    datatypes.JSON(concatParts(req.Message.Parts, loopResult.Parts)),
			Metadata: datatypes.JSON(metadataJSON),
		})
	} else {
		userParts, _ := json.Marshal(req.Message.Parts)
		_ = h.chats.UpsertMessage(persistCtx, &models.ChatMessage{
			ID:       req.Message.ID,
			ThreadID: details.Thread.ID,
			Role:     req.Message.Role,
			Parts:    datatypes.JSON(userParts),
		})

		if loopErr == nil || loopResult.Text != "" {
			_ = h.chats.UpsertMessage(persistCtx, &models.ChatMessage{
				ID:       responseID,
				ThreadID: details.Thread.ID,
				Role:     "assistant",
				Parts:    datatypes.JSON(loopResult.Parts),
				Metadata: datatypes.JSON(metadataJSON),
			})
		}
	}

	_ = em.Finish(metadata)
	_ = em.Done()

	return result, nil
}

// isToolCallAllowed ports route.ts:170's gate (minus the tool-call-
// unsupported-model and imageTool checks this rewrite has no equivalent
// for): toolChoice "none" still allows tool loading when the user
// explicitly @-mentioned something -- an explicit mention overrides the
// blanket toggle.
func isToolCallAllowed(req TurnRequest) bool {
	return req.ToolChoice != "none" || len(req.Mentions) > 0
}

// activeAppDefaultTools ports loadAppDefaultTools (shared.chat.ts:427):
// defaultTool mentions take priority over allowedAppDefaultToolkit, which
// itself defaults to every toolkit when the request omits the key entirely.
func activeAppDefaultTools(req TurnRequest, deps tools.Deps) []tools.Definition {
	if !isToolCallAllowed(req) {
		return nil
	}
	var mentionNames []string
	for _, m := range req.Mentions {
		if m.Type == "defaultTool" {
			mentionNames = append(mentionNames, m.Name)
		}
	}
	return tools.Filter(tools.Defaults(deps), req.AllowedAppDefaultToolkit, mentionNames)
}

// priorMetadata reads the running totals off the message being continued.
//
// Absent or unparseable metadata reads as zero rather than as an error: the
// totals are a display figure, and a turn whose duration restarts at zero is
// a much smaller problem than a turn that fails to save.
func priorMetadata(msg uiMessage, continuing bool) chatMetadata {
	var prior chatMetadata
	if !continuing || len(msg.Metadata) == 0 {
		return prior
	}
	_ = json.Unmarshal(msg.Metadata, &prior)
	return prior
}

// addUsage sums token counts across the rounds of one turn.
func addUsage(prior, next *bifrostai.Usage) *bifrostai.Usage {
	if prior == nil {
		return next
	}
	if next == nil {
		return prior
	}
	return &bifrostai.Usage{
		PromptTokens:     prior.PromptTokens + next.PromptTokens,
		CompletionTokens: prior.CompletionTokens + next.CompletionTokens,
		TotalTokens:      prior.TotalTokens + next.TotalTokens,
	}
}

// concatParts appends this round's parts to the parts already in the turn.
//
// Both sides are already-encoded JSON, so this splices arrays rather than
// re-marshalling anything: a part that survived a round trip through the
// browser keeps whatever fields this Go code does not model.
func concatParts(prior []json.RawMessage, next json.RawMessage) []byte {
	var added []json.RawMessage
	if len(next) > 0 {
		_ = json.Unmarshal(next, &added)
	}
	merged, err := json.Marshal(append(append([]json.RawMessage{}, prior...), added...))
	if err != nil {
		// Unreachable short of a part that is not valid JSON, which cannot
		// happen -- both inputs were decoded from JSON. Keeping the turn so
		// far beats persisting nothing.
		merged, _ = json.Marshal(prior)
	}
	return merged
}

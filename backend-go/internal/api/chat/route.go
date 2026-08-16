package chat

import (
	"encoding/json"
	"net/http"
	"time"

	"gorm.io/datatypes"

	"amiro/backend/internal/agent/permission"
	"amiro/backend/internal/agent/workspace"
	bifrostai "amiro/backend/internal/ai/bifrost"
	"amiro/backend/internal/ai/prompts"
	"amiro/backend/internal/ai/tools"
	"amiro/backend/internal/ai/uimessage"
	"amiro/backend/internal/auth"
	"amiro/backend/internal/db/models"
	"amiro/backend/internal/user"
)

// mentionDTO ports ChatMention (types/chat.ts:45)'s discriminated union
// flattened into one struct (Go has no native union types, same choice
// internal/ai/workflow/types.go's WorkflowToolKey already makes) -- Type
// selects which of the identifier fields is meaningful:
// mcpTool/mcpServer -> ServerID (+ Name for mcpTool's specific tool name),
// workflow -> WorkflowID, agent -> AgentID, defaultTool -> Name.
type mentionDTO struct {
	Type       string `json:"type"`
	Name       string `json:"name"`
	ServerID   string `json:"serverId,omitempty"`
	WorkflowID string `json:"workflowId,omitempty"`
	AgentID    string `json:"agentId,omitempty"`
}

// allowedMCPServerDTO ports AllowedMCPServer (types/mcp.ts).
type allowedMCPServerDTO struct {
	Tools []string `json:"tools"`
}

// chatRequest ports chatApiSchemaRequestBodySchema (types/chat.ts:96).
// imageTool/attachments are still intentionally not read -- see
// shared.go's doc comment for the attachments gap; there's no image-
// generation tool in this rewrite's catalog to bind imageTool to.
type chatRequest struct {
	ID                       string                         `json:"id"`
	Message                  uiMessage                      `json:"message"`
	ChatModel                *chatModelDTO                  `json:"chatModel"`
	ToolChoice               string                         `json:"toolChoice"`
	Mentions                 []mentionDTO                   `json:"mentions"`
	AllowedAppDefaultToolkit *[]string                      `json:"allowedAppDefaultToolkit"`
	AllowedMcpServers        map[string]allowedMCPServerDTO `json:"allowedMcpServers"`
	// PermissionMode is "plan" | "manual" | "edit" | "auto". Absent or
	// unrecognized means interactive/manual -- see permission.ParseMode for why the
	// fallback is the asking mode rather than the permissive one.
	PermissionMode string `json:"permissionMode"`
	// WorkspaceRoot is the selected project directory to scope file and shell tools.
	WorkspaceRoot string `json:"workspaceRoot,omitempty"`
	ProjectDir    string `json:"projectDir,omitempty"`
}

// chatMetadata ports ChatMetadata (types/chat.ts:7).
type chatMetadata struct {
	Usage      *bifrostai.Usage `json:"usage,omitempty"`
	ChatModel  *chatModelDTO    `json:"chatModel,omitempty"`
	ToolChoice string           `json:"toolChoice,omitempty"`
	ToolCount  int              `json:"toolCount"`
	AgentID    string           `json:"agentId,omitempty"`

	// DurationMS is how long the whole turn spent working, summed across
	// every round an approval split it into.
	//
	// It is sent because the browser cannot measure it. A thread reopened
	// tomorrow has no start time to subtract from, and the work log's
	// fallback there was a step count -- which answers a different question
	// than the one "how long did that take?" asks.
	//
	// No omitempty: absent and zero mean different things to the reader of
	// this field. Absent is a message written before the server measured
	// anything, where the work log falls back to a step count; zero is a
	// turn that really was that fast.
	DurationMS int64 `json:"durationMs"`
}

// isToolCallAllowed ports route.ts:170's gate (minus the tool-call-
// unsupported-model and imageTool checks this rewrite has no equivalent
// for): toolChoice "none" still allows tool loading when the user
// explicitly @-mentioned something -- an explicit mention overrides the
// blanket toggle.
func isToolCallAllowed(req chatRequest) bool {
	return req.ToolChoice != "none" || len(req.Mentions) > 0
}

// activeAppDefaultTools ports loadAppDefaultTools (shared.chat.ts:427):
// defaultTool mentions take priority over allowedAppDefaultToolkit, which
// itself defaults to every toolkit when the request omits the key
// entirely.
func activeAppDefaultTools(req chatRequest, deps tools.Deps) []tools.Definition {
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

// Chat ports route.ts's POST handler (chat/route.ts:57): resolve the
// thread, resolve the model and agent, load every mentioned/allowed tool
// (MCP, workflow, app-default), run the (possibly multi-step, tool-calling)
// reply, persist both sides.
func (h *Handler) Chat(w http.ResponseWriter, r *http.Request) {
	authedUser, ok := auth.UserFromContext(r.Context())
	if !ok {
		http.Error(w, "Unauthorized", http.StatusUnauthorized)
		return
	}

	var req chatRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		http.Error(w, "invalid request body", http.StatusBadRequest)
		return
	}
	if req.ID == "" || req.Message.ID == "" {
		http.Error(w, "id and message are required", http.StatusBadRequest)
		return
	}

	ctx := r.Context()

	details, err := h.chats.SelectThreadDetails(ctx, req.ID)
	if err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}
	if details == nil {
		thread := &models.ChatThread{ID: req.ID, Title: "", UserID: authedUser.ID}
		if err := h.chats.InsertThread(ctx, thread); err != nil {
			http.Error(w, err.Error(), http.StatusInternalServerError)
			return
		}
		details, err = h.chats.SelectThreadDetails(ctx, req.ID)
		if err != nil || details == nil {
			http.Error(w, "failed to create thread", http.StatusInternalServerError)
			return
		}
	}
	if details.Thread.UserID != authedUser.ID {
		http.Error(w, "Forbidden", http.StatusForbidden)
		return
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
	agent, mentions := h.resolveAgent(ctx, authedUser.ID, req.Mentions)
	var agentInfo *prompts.AgentPromptInfo
	agentID := ""
	if agent != nil {
		agentInfo = agent.Info
		agentID = agent.ID
	}

	var activeTools []tools.Definition
	systemExtra := ""
	if isToolCallAllowed(req) {
		mcpResult, mcpErr := h.loadMCPTools(ctx, authedUser.ID, mentions, req.AllowedMcpServers)
		if mcpErr == nil {
			activeTools = mergeToolDefinitions(activeTools, mcpResult.Defs)
			systemExtra = h.mcpCustomizationSystemPrompt(ctx, authedUser.ID, mcpResult.ToolsByServer, mcpResult.Servers)
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
	activeTools = mergeToolDefinitions(activeTools, activeAppDefaultTools(reqForDefaults, tools.Deps{
		Workspace: activeWS,
		Todos:     h.todos,
		SessionID: details.Thread.ID,
		Memory:    h.notes,
		LSP:       h.lsp,
	}))

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
	// handler: everything above is thread lookup and tool loading, and the
	// approved tool below is work the turn should be charged for.
	//
	// Deliberately per-request, so the stretch where the turn sat waiting
	// for a human to read an approval card is not counted. "Worked for 4m"
	// on a turn that spent three of them idle would be a lie about the
	// agent, and the reader is asking about the agent.
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

	system := prompts.MergeSystemPrompt(
		prompts.BuildUserSystemPrompt(authedUser, user.ParsePreferences(details.Preferences), agentInfo),
		systemExtra,
		notes,
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

	sw := uimessage.NewWriter(w)
	_ = sw.Start(responseID)

	loopResult, loopErr := runToolLoop(ctx, h.engine, sw, resolved, system, engineMessages, activeTools, perms)
	if loopErr != nil {
		_ = sw.Error(loopErr.Error())
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
	_ = sw.Finish(metadata)
	_ = sw.Done()

	// Persist even if the loop errored partway through -- matches onFinish
	// always running in the TS route (createUIMessageStream calls onFinish
	// regardless of whether the model call itself failed).
	metadataJSON, _ := json.Marshal(metadata)

	if continuing {
		// One write, because the row being continued and the row being
		// written are the same row. req.Message.Parts is the turn up to the
		// pause with the approval already resolved in place by
		// resolveApprovals, so this stores the answered call rather than the
		// question a reloaded thread would otherwise re-ask.
		_ = h.chats.UpsertMessage(ctx, &models.ChatMessage{
			ID:       responseID,
			ThreadID: details.Thread.ID,
			Role:     "assistant",
			Parts:    datatypes.JSON(concatParts(req.Message.Parts, loopResult.Parts)),
			Metadata: datatypes.JSON(metadataJSON),
		})
		return
	}

	userParts, _ := json.Marshal(req.Message.Parts)
	_ = h.chats.UpsertMessage(ctx, &models.ChatMessage{
		ID:       req.Message.ID,
		ThreadID: details.Thread.ID,
		Role:     req.Message.Role,
		Parts:    datatypes.JSON(userParts),
	})

	if loopErr == nil || loopResult.Text != "" {
		_ = h.chats.UpsertMessage(ctx, &models.ChatMessage{
			ID:       responseID,
			ThreadID: details.Thread.ID,
			Role:     "assistant",
			Parts:    datatypes.JSON(loopResult.Parts),
			Metadata: datatypes.JSON(metadataJSON),
		})
	}
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

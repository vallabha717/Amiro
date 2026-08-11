package chat

import (
	"encoding/json"
	"net/http"

	"gorm.io/datatypes"

	bifrostai "betterchatbot/backend/internal/ai/bifrost"
	"betterchatbot/backend/internal/ai/prompts"
	"betterchatbot/backend/internal/ai/tools"
	"betterchatbot/backend/internal/ai/uimessage"
	"betterchatbot/backend/internal/auth"
	"betterchatbot/backend/internal/db/models"
	"betterchatbot/backend/internal/user"
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
}

// chatMetadata ports ChatMetadata (types/chat.ts:7).
type chatMetadata struct {
	Usage      *bifrostai.Usage `json:"usage,omitempty"`
	ChatModel  *chatModelDTO    `json:"chatModel,omitempty"`
	ToolChoice string           `json:"toolChoice,omitempty"`
	ToolCount  int              `json:"toolCount"`
	AgentID    string           `json:"agentId,omitempty"`
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
func activeAppDefaultTools(req chatRequest) []tools.Definition {
	if !isToolCallAllowed(req) {
		return nil
	}
	var mentionNames []string
	for _, m := range req.Mentions {
		if m.Type == "defaultTool" {
			mentionNames = append(mentionNames, m.Name)
		}
	}
	return tools.Filter(tools.Defaults(), req.AllowedAppDefaultToolkit, mentionNames)
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

	engineMessages := make([]bifrostai.Message, 0, len(history)+1)
	for _, m := range history {
		engineMessages = append(engineMessages, dbMessageToEngines(m)...)
	}
	engineMessages = append(engineMessages, req.Message.toEngineMessages()...)
	engineMessages = resolveAttachmentURLs(ctx, engineMessages)

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
	// Run activeAppDefaultTools against the agent-merged mentions, not just
	// req.Mentions -- an agent's own defaultTool mentions (resolveAgent
	// already appended them into `mentions` above) should apply exactly
	// like a manually-typed one, matching how the TS route pushes
	// agent.instructions.mentions into the same `mentions` array
	// loadAppDefaultTools later reads (route.ts:176-187, shared.chat.ts:427).
	reqForDefaults := req
	reqForDefaults.Mentions = mentions
	activeTools = mergeToolDefinitions(activeTools, activeAppDefaultTools(reqForDefaults))

	system := prompts.MergeSystemPrompt(
		prompts.BuildUserSystemPrompt(authedUser, user.ParsePreferences(details.Preferences), agentInfo),
		systemExtra,
	)

	responseID := models.NewID()
	sw := uimessage.NewWriter(w)
	_ = sw.Start(responseID)

	loopResult, loopErr := runToolLoop(ctx, h.engine, sw, resolved, system, engineMessages, activeTools)
	if loopErr != nil {
		_ = sw.Error(loopErr.Error())
	}

	metadata := chatMetadata{
		Usage: loopResult.Usage, ChatModel: &chatModel, ToolChoice: req.ToolChoice, ToolCount: len(activeTools), AgentID: agentID,
	}
	_ = sw.Finish(metadata)
	_ = sw.Done()

	// Persist both sides even if the loop errored partway through --
	// matches onFinish always running in the TS route (createUIMessageStream
	// calls onFinish regardless of whether the model call itself failed).
	userParts, _ := json.Marshal(req.Message.Parts)
	_ = h.chats.UpsertMessage(ctx, &models.ChatMessage{
		ID:       req.Message.ID,
		ThreadID: details.Thread.ID,
		Role:     req.Message.Role,
		Parts:    datatypes.JSON(userParts),
	})

	if loopErr == nil || loopResult.Text != "" {
		metadataJSON, _ := json.Marshal(metadata)
		_ = h.chats.UpsertMessage(ctx, &models.ChatMessage{
			ID:       responseID,
			ThreadID: details.Thread.ID,
			Role:     "assistant",
			Parts:    datatypes.JSON(loopResult.Parts),
			Metadata: datatypes.JSON(metadataJSON),
		})
	}
}

// Package prompts ports the subset of src/lib/ai/prompts.ts needed by
// Phase 3's chat routes: the thread-title prompt and the two user/voice
// system-prompt builders (now including their `agent` parameter, Phase 8),
// the agent-generation prompt behind POST /api/agent/ai (Phase 6), plus
// mergeSystemPrompt and the MCP-server-customizations prompt section
// (Phase 8's mention-driven tool loading).
package prompts

import (
	"fmt"
	"sort"
	"strings"
	"time"

	"amiro/backend/internal/db/models"
	"amiro/backend/internal/mcp"
	"amiro/backend/internal/user"
)

// CreateThreadTitlePrompt ports CREATE_THREAD_TITLE_PROMPT (prompts.ts:9).
const CreateThreadTitlePrompt = `
You are a chat title generation expert.

Critical rules:
- Generate a concise title based on the first user message
- Title must be under 80 characters (absolutely no more than 80 characters)
- Summarize only the core content clearly
- Do not use quotes, colons, or special characters
- Use the same language as the user's message`

const currentTimeLayout = "Monday, January 2, 2006 at 3:04:05 PM"

// GenerateExampleToolSchemaPrompt ports generateExampleToolSchemaPrompt
// (prompts.ts:257), used by POST /api/ai/generate-example-tool-schema
// (Phase 7).
func GenerateExampleToolSchemaPrompt(toolName, toolDescription, userPrompt string) string {
	step := userPrompt
	if step == "" {
		step = "Step 1: Create a realistic example question or scenario that a user might ask to use this tool.\n" +
			"Step 2: Based on that question, generate a valid JSON input object that matches the input schema of the tool."
	}
	return fmt.Sprintf(`
You are given a tool with the following details:
- Tool Name: %s
- Tool Description: %s

%s
`, toolName, toolDescription, step)
}

// AgentPromptInfo carries the subset of a bound Agent (types/agent.ts:71)
// BuildUserSystemPrompt needs: its display name plus instructions.role/
// systemPrompt (prompts.ts:51's `agent` parameter).
type AgentPromptInfo struct {
	Name         string
	Role         string
	SystemPrompt string
}

// BuildUserSystemPrompt ports buildUserSystemPrompt (prompts.ts:51),
// including the agent parameter (Phase 8's mention-driven agent wiring) --
// agent may be nil for a plain, agent-free chat turn (also used by
// temporary.go, which never binds an agent).
func BuildUserSystemPrompt(u *models.User, prefs *user.Preferences, agent *AgentPromptInfo) string {
	assistantName := "Amiro"
	if prefs != nil && prefs.BotName != "" {
		assistantName = prefs.BotName
	}
	if agent != nil && agent.Name != "" {
		assistantName = agent.Name
	}

	var b strings.Builder
	fmt.Fprintf(&b, "You are %s", assistantName)
	if agent != nil && agent.Role != "" {
		fmt.Fprintf(&b, ". You are an expert in %s", agent.Role)
	}
	fmt.Fprintf(&b, ". The current date and time is %s.", time.Now().Format(currentTimeLayout))

	if agent != nil && agent.SystemPrompt != "" {
		fmt.Fprintf(&b, "\n  # Core Instructions\n  <core_capabilities>\n  %s\n  </core_capabilities>", agent.SystemPrompt)
	}

	var userInfo []string
	if u != nil && u.Name != "" {
		userInfo = append(userInfo, "Name: "+u.Name)
	}
	if u != nil && u.Email != "" {
		userInfo = append(userInfo, "Email: "+u.Email)
	}
	if prefs != nil && prefs.Profession != "" {
		userInfo = append(userInfo, "Profession: "+prefs.Profession)
	}
	if len(userInfo) > 0 {
		fmt.Fprintf(&b, "\n\n<user_information>\n%s\n</user_information>", strings.Join(userInfo, "\n"))
	}

	b.WriteString("\n\n<general_capabilities>\n")
	b.WriteString("You can assist with:\n")
	b.WriteString("- Analysis and problem-solving across various domains\n")
	b.WriteString("- Using available tools and resources to complete tasks\n")
	b.WriteString("- Adapting communication to user preferences and context\n")
	b.WriteString("</general_capabilities>")

	displayName := ""
	if prefs != nil {
		displayName = prefs.DisplayName
	}
	if displayName == "" && u != nil {
		displayName = u.Name
	}
	hasStyleExample := prefs != nil && prefs.ResponseStyleExample != ""

	if displayName != "" || hasStyleExample {
		b.WriteString("\n\n<communication_preferences>")
		if displayName != "" {
			fmt.Fprintf(&b, "\n- Address the user as %q when appropriate to personalize interactions", displayName)
		}
		if hasStyleExample {
			fmt.Fprintf(&b, "\n- Match this communication style and tone:\n\"\"\"\n%s\n\"\"\"", prefs.ResponseStyleExample)
		}
		b.WriteString("\n\n- When using tools, briefly mention which tool you'll use with natural phrases")
		b.WriteString("\n- Examples: \"I'll search for that information\", \"Let me check the weather\", \"I'll run some calculations\"")
		b.WriteString("\n- Use `mermaid` code blocks for diagrams and charts when helpful")
		b.WriteString("\n</communication_preferences>")
	}

	return b.String()
}

// BuildSpeechSystemPrompt ports buildSpeechSystemPrompt (prompts.ts:135),
// minus the agent parameter (Phase 6).
func BuildSpeechSystemPrompt(u *models.User, prefs *user.Preferences) string {
	assistantName := "Assistant"
	if prefs != nil && prefs.BotName != "" {
		assistantName = prefs.BotName
	}

	var b strings.Builder
	fmt.Fprintf(&b, "You are %s. The current date and time is %s.", assistantName, time.Now().Format(currentTimeLayout))

	var userInfo []string
	if u != nil && u.Name != "" {
		userInfo = append(userInfo, "Name: "+u.Name)
	}
	if u != nil && u.Email != "" {
		userInfo = append(userInfo, "Email: "+u.Email)
	}
	if prefs != nil && prefs.Profession != "" {
		userInfo = append(userInfo, "Profession: "+prefs.Profession)
	}
	if len(userInfo) > 0 {
		fmt.Fprintf(&b, "\n\n<user_information>\n%s\n</user_information>", strings.Join(userInfo, "\n"))
	}

	b.WriteString("\n\n<voice_capabilities>\n")
	b.WriteString("You excel at conversational voice interactions by:\n")
	b.WriteString("- Providing clear, natural spoken responses\n")
	b.WriteString("- Using available tools to gather information and complete tasks\n")
	b.WriteString("- Adapting communication to user preferences and context\n")
	b.WriteString("</voice_capabilities>")

	displayName := ""
	if prefs != nil {
		displayName = prefs.DisplayName
	}
	if displayName == "" && u != nil {
		displayName = u.Name
	}
	hasStyleExample := prefs != nil && prefs.ResponseStyleExample != ""

	if displayName != "" || hasStyleExample {
		b.WriteString("\n\n<communication_preferences>")
		if displayName != "" {
			fmt.Fprintf(&b, "\n- Address the user as %q when appropriate to personalize interactions", displayName)
		}
		if hasStyleExample {
			fmt.Fprintf(&b, "\n- Match this communication style and tone:\n\"\"\"\n%s\n\"\"\"", prefs.ResponseStyleExample)
		}
		b.WriteString("\n</communication_preferences>")
	}

	b.WriteString("\n\n<voice_interaction_guidelines>\n")
	b.WriteString("- Speak in short, conversational sentences (one or two per reply)\n")
	b.WriteString("- Use simple words; avoid jargon unless the user uses it first\n")
	b.WriteString("- Never use lists, markdown, or code blocks—just speak naturally\n")
	b.WriteString("- When using tools, briefly mention what you're doing: \"Let me search for that\" or \"I'll check the weather\"\n")
	b.WriteString("- If a request is ambiguous, ask a brief clarifying question instead of guessing\n")
	b.WriteString("</voice_interaction_guidelines>")

	return strings.TrimSpace(b.String())
}

// BuildAgentGenerationPrompt ports buildAgentGenerationPrompt
// (prompts.ts:19): the system prompt behind POST /api/agent/ai, with the
// caller's available tool names spliced into step 4.
func BuildAgentGenerationPrompt(toolNames []string) string {
	var toolsList strings.Builder
	for i, name := range toolNames {
		if i > 0 {
			toolsList.WriteString("\n")
		}
		toolsList.WriteString("- ")
		toolsList.WriteString(name)
	}

	return `You are an elite AI agent architect. Your mission is to translate user requirements into robust, high-performance agent configurations. Follow these steps for every request:

1. Extract Core Intent: Carefully analyze the user's input to identify the fundamental purpose, key responsibilities, and success criteria for the agent. Consider both explicit and implicit needs.

2. Design Expert Persona: Define a compelling expert identity for the agent, ensuring deep domain knowledge and a confident, authoritative approach to decision-making.

3. Architect Comprehensive Instructions: Write a system prompt that:
- Clearly defines the agent's behavioral boundaries and operational parameters
- Specifies methodologies, best practices, and quality control steps for the task
- Anticipates edge cases and provides guidance for handling them
- Incorporates any user-specified requirements or preferences
- Defines output format expectations when relevant

4. Strategic Tool Selection: Select only tools crucially necessary for achieving the agent's mission effectively from available tools:
` + toolsList.String() + `

5. Optimize for Performance: Include decision-making frameworks, self-verification steps, efficient workflow patterns, and clear escalation or fallback strategies.

6. Output Generation: Return a structured object with these fields:
- name: Concise, descriptive name reflecting the agent's primary function
- description: 1-2 sentences capturing the unique value and primary benefit to users  
- role: Precise domain-specific expertise area
- instructions: The comprehensive system prompt from steps 2-5
- tools: Array of selected tool names from step 4

CRITICAL: Generate all output content in the same language as the user's request. Be specific and comprehensive. Proactively seek clarification if requirements are ambiguous. Your output should enable the new agent to operate autonomously and reliably within its domain.`
}

// BuildPlanContractPrompt is the propose-plan-then-approve contract
// (docs/agentic-loop-implementation-plan.md, Phase 6).
//
// Plan mode used to be purely negative -- the permission engine refused every
// consequential call and nothing ever asked the model to produce something
// the user could agree to. The result was a mode whose output was prose in
// the chat and no decision point. This is the positive half: in Plan mode the
// turn is supposed to *end* in a proposal.
//
// Returned empty for an unrecognized mode rather than defaulting to the
// interactive text. The caller only includes this when the plan tools were
// actually loaded, and the same reasoning applies one level down: a prompt
// describing a contract that does not hold this turn is worse than silence.
func BuildPlanContractPrompt(mode string) string {
	switch strings.ToLower(strings.TrimSpace(mode)) {
	case "plan":
		return `<planning>
You are in Plan mode. Every consequential tool call will be refused, so do not attempt one -- read, search and map the codebase instead.

Finish by calling propose_plan. Do not deliver the plan as a chat message: a plan the user cannot approve or comment on is not a plan, it is a suggestion, and this turn cannot act on it either way.

Before you propose: read enough to name the actual files and the actual functions. A plan built from guesses reads exactly like a plan built from evidence, and the user cannot tell them apart until you are halfway through executing the wrong one.
</planning>`
	case "manual", "interactive", "edit", "auto":
		return `<planning>
For work that will touch several files or is hard to undo, call propose_plan first and let the user agree to the approach before you start. For a small, obvious change, just do it -- asking permission to fix a typo wastes the user's attention on the turns where it is worth nothing.

When a turn is done and it changed files, call walkthrough: what changed, and in what order someone should read it.
</planning>`
	default:
		return ""
	}
}

// MergeSystemPrompt ports mergeSystemPrompt (shared.chat.ts:106): joins
// every non-empty prompt with a blank line between them.
func MergeSystemPrompt(prompts ...string) string {
	filtered := make([]string, 0, len(prompts))
	for _, p := range prompts {
		p = strings.TrimSpace(p)
		if p != "" {
			filtered = append(filtered, p)
		}
	}
	return strings.Join(filtered, "\n\n")
}

// McpServerCustomizationToolPrompt is one tool's per-user customization
// instruction, keyed by its origin (unprefixed) tool name.
type McpServerCustomizationPrompt struct {
	ServerName string
	Prompt     string
	Tools      map[string]string // origin tool name -> instruction
}

// BuildMcpServerCustomizationsSystemPrompt ports
// buildMcpServerCustomizationsSystemPrompt (prompts.ts:224): a
// "Tool Usage Guidelines" section per server that has a saved
// prompt/tool instruction, using createMCPToolId's exact `<server>_<tool>`
// naming so a customization visibly names the tool ID the model actually
// sees.
func BuildMcpServerCustomizationsSystemPrompt(instructions []McpServerCustomizationPrompt) string {
	var body strings.Builder
	for _, v := range instructions {
		if v.Prompt == "" && len(v.Tools) == 0 {
			continue
		}
		fmt.Fprintf(&body, "<%s>\n", v.ServerName)
		if v.Prompt != "" {
			fmt.Fprintf(&body, "- %s\n", v.Prompt)
		}
		toolNames := make([]string, 0, len(v.Tools))
		for toolName := range v.Tools {
			toolNames = append(toolNames, toolName)
		}
		sort.Strings(toolNames)
		for _, toolName := range toolNames {
			fmt.Fprintf(&body, "- **%s**: %s\n", mcp.ToolID(v.ServerName, toolName), v.Tools[toolName])
		}
		fmt.Fprintf(&body, "</%s>\n", v.ServerName)
	}
	if body.Len() == 0 {
		return ""
	}
	return strings.TrimSpace(fmt.Sprintf(`### Tool Usage Guidelines
- When using tools, please follow the guidelines below unless the user provides specific instructions otherwise.
- These customizations help ensure tools are used effectively and appropriately for the current context.
%s`, strings.TrimSpace(body.String())))
}

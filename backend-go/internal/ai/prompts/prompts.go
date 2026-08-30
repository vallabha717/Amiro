// Package prompts ports the subset of src/lib/ai/prompts.ts needed by
// Phase 3's chat routes: the thread-title prompt and the two user/voice
// system-prompt builders, plus mergeSystemPrompt and the
// MCP-server-customizations prompt section (Phase 8's mention-driven tool
// loading). The user system-prompt builder carried a bound agent's persona
// (a Phase 8 addition) and this package also carried the agent-generation
// prompt behind the agent-authoring route; both were removed with the rest
// of the agent feature in Phase 6 (docs/skills/, a later and unrelated
// "Phase 6" from a different plan).
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

// BuildUserSystemPrompt ports buildUserSystemPrompt (prompts.ts:51), minus
// its `agent` parameter -- the bound-agent system prompt and
// <core_capabilities> block it fed were removed with the rest of the agent
// feature in Phase 6 (docs/skills/).
func BuildUserSystemPrompt(u *models.User, prefs *user.Preferences) string {
	assistantName := "Amiro"
	if prefs != nil && prefs.BotName != "" {
		assistantName = prefs.BotName
	}

	var b strings.Builder
	fmt.Fprintf(&b, "You are %s", assistantName)
	fmt.Fprintf(&b, ". The current date and time is %s.", time.Now().Format(currentTimeLayout))

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

// BuildSkillGenerationPrompt is the system prompt behind POST
// /api/skills/generate (docs/skills/phases/phase-05-skills-ui.md). It bakes
// in the same authoring rules internal/skills/validate.go enforces at save
// time, so a generated draft is very likely to save clean on the first try
// rather than bouncing off field errors -- but the model's output is never
// trusted directly; ValidateName/ValidateDescription/ValidateBody run again
// client-side before the draft is even allowed to populate the form, and
// the server-side validator in internal/skills runs again on save.
func BuildSkillGenerationPrompt() string {
	return `You are an expert at writing Agent Skills for Amiro -- reusable, model-invoked packets of instructions that teach the assistant how to do one specific task well. Given a short description of what the user wants, draft a complete SKILL.md.

1. Choose a name: lowercase letters, digits and single hyphens only, matching /^[a-z0-9]+(-[a-z0-9]+)*$/, at most 64 characters, and descriptive of the skill's purpose (e.g. "pdf-form-fill", "changelog-writer"). Never include "claude" or "anthropic" in the name.

2. Write a description that states both WHAT the skill does and WHEN the assistant should reach for it, in third person ("Fills out PDF forms from structured data. Use when the user needs to populate an existing PDF template."). This is the only text the assistant sees before deciding to load the skill, so make the trigger condition concrete. At most 1024 characters.

3. Write the body as the SKILL.md markdown content: clear step-by-step instructions an assistant with no other context could follow, covering the common case first and edge cases after. Keep it under roughly 500 lines -- push any long reference material, example files or scripts into a "See references/" note rather than inlining it, since this generator only produces the SKILL.md itself.

Output a structured object with exactly these fields:
- name: the skill's directory name, per rule 1
- description: the what-and-when description, per rule 2
- body: the SKILL.md markdown body, per rule 3 (do not include YAML frontmatter -- name and description are supplied separately)

CRITICAL: Generate all output content in the same language as the user's request. Be specific and actionable -- a vague skill is worse than no skill.`
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

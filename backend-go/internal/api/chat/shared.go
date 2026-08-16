// Package chat ports src/app/api/chat/**: the streaming chat handler, plus
// models/title/temporary/export/openai-realtime. App-default tools
// (visualization, HTTP fetch, web search, JS/Python execution --
// internal/ai/tools), MCP tools, workflow-as-tool, and agent application
// (system prompt + pre-bound mentions) are all wired into the multi-step
// tool-calling loop -- see route.go's Chat handler and mentions.go.
package chat

import (
	"bytes"
	"encoding/json"
	"strings"

	bifrostai "amiro/backend/internal/ai/bifrost"
	"amiro/backend/internal/db/models"
)

// chatModelDTO ports ChatModel (types/chat.ts:15).
type chatModelDTO struct {
	Provider string `json:"provider"`
	Model    string `json:"model"`
}

// uiPart is the minimal shape read out of a UIMessage part
// (node_modules/ai's UIMessagePart union) -- the "type"/"text" fields every
// text part carries. Every other part variant (file, source-url, tool-*,
// reasoning, data-*) round-trips untouched as raw JSON when persisted;
// tool-* parts are additionally read by toolPart below.
type uiPart struct {
	Type string `json:"type"`
	Text string `json:"text"`
}

// filePart is the minimal shape read out of a FileUIPart (node_modules/ai's
// `{type:"file", url, mediaType, filename}`, confirmed against
// prompt-input.tsx's own attachmentParts construction -- the live frontend
// this backend serves).
type filePart struct {
	Type      string `json:"type"`
	URL       string `json:"url"`
	MediaType string `json:"mediaType"`
	Filename  string `json:"filename"`
}

// toolPart is the minimal shape read out of a ToolUIPart
// (node_modules/ai's `type: "tool-<name>"` part, confirmed against
// ai/dist/index.js's ui-message-chunks schema). Only a part whose State is
// "output-available" or "output-error" represents a completed round trip
// worth forwarding to the model as history -- a still-pending
// "input-available" part (a client tool, e.g. JS/Python execution, that
// hasn't returned a result yet) is skipped, same as it would never have
// been in the message the frontend actually resubmits (see route.go's doc
// comment on the tool-calling loop for why that pending state is never
// persisted either).
type toolPart struct {
	Type       string          `json:"type"`
	ToolCallID string          `json:"toolCallId"`
	State      string          `json:"state"`
	Input      json.RawMessage `json:"input"`
	Output     json.RawMessage `json:"output"`
	ErrorText  string          `json:"errorText"`
}

// uiMessage is the minimal shape read out of a UIMessage
// (chatApiSchemaRequestBodySchema's `message: z.any() as
// z.ZodType<UIMessage>`, types/chat.ts:98).
type uiMessage struct {
	ID       string            `json:"id"`
	Role     string            `json:"role"`
	Parts    []json.RawMessage `json:"parts"`
	Metadata json.RawMessage   `json:"metadata,omitempty"`
}

// textOf concatenates every "text"-typed part's text, in order, the same
// way convertToModelMessages ultimately joins a UIMessage's text parts
// into one model-message content string. Non-text parts are ignored here
// (still persisted verbatim -- see route.go's DB write).
func (m uiMessage) textOf() string {
	var text string
	for _, raw := range m.Parts {
		var p uiPart
		if err := json.Unmarshal(raw, &p); err != nil {
			continue
		}
		if p.Type != "text" {
			continue
		}
		if text != "" {
			text += "\n\n"
		}
		text += p.Text
	}
	return text
}

func engineRole(role string) bifrostai.MessageRole {
	switch role {
	case "assistant":
		return bifrostai.RoleAssistant
	case "system":
		return bifrostai.RoleSystem
	default:
		return bifrostai.RoleUser
	}
}

// toEngineMessages converts a uiMessage into the engine turn(s)
// internal/ai/bifrost.Client expects, porting convertToModelMessages'
// splitting of one multi-part UIMessage (interleaved text and completed
// tool-call/tool-result parts) into the separate assistant/tool model
// messages a provider actually requires. Each completed tool part becomes
// exactly two messages: an assistant turn carrying that one tool call, then
// a tool-role turn carrying its result -- text before/after is flushed as
// its own plain turn around them, preserving order. A batch of N parallel
// tool calls in a single step therefore round-trips as N call/result pairs
// rather than one assistant message with N tool_calls; providers accept
// either shape, and this is far simpler to build back up correctly than
// re-inferring which calls were "the same step" from persisted JSON alone.
func (m uiMessage) toEngineMessages() []bifrostai.Message {
	role := engineRole(m.Role)
	var out []bifrostai.Message
	var textBuf string
	var pendingAttachments []bifrostai.Attachment

	flushText := func() {
		if textBuf != "" || len(pendingAttachments) > 0 {
			out = append(out, bifrostai.Message{Role: role, Text: textBuf, Attachments: pendingAttachments})
			textBuf = ""
			pendingAttachments = nil
		}
	}

	// Attachments can't ride on a tool-call message (that message carries
	// tool_calls, not content blocks), so they still flush as their own turn.
	flushAttachmentsOnly := func() {
		if len(pendingAttachments) > 0 {
			out = append(out, bifrostai.Message{Role: role, Attachments: pendingAttachments})
			pendingAttachments = nil
		}
	}

	for _, raw := range m.Parts {
		var p toolPart
		if err := json.Unmarshal(raw, &p); err != nil {
			continue
		}
		if p.Type == "text" {
			var tp uiPart
			if err := json.Unmarshal(raw, &tp); err != nil {
				continue
			}
			if textBuf != "" {
				textBuf += "\n\n"
			}
			textBuf += tp.Text
			continue
		}
		if p.Type == "file" {
			var fp filePart
			if err := json.Unmarshal(raw, &fp); err == nil && fp.URL != "" {
				pendingAttachments = append(pendingAttachments, bifrostai.Attachment{URL: fp.URL, MediaType: fp.MediaType, Filename: fp.Filename})
			}
			continue
		}
		if !strings.HasPrefix(p.Type, "tool-") {
			continue
		}
		if p.State != "output-available" && p.State != "output-error" {
			continue
		}

		// Any text the assistant said before calling the tool rides along on
		// the tool-call message itself rather than being flushed as a
		// separate assistant turn ahead of it.
		//
		// The OpenAI wire format models one assistant turn as a single
		// message carrying both `content` and `tool_calls`. Splitting it into
		// assistant(text) + assistant(tool_calls) is accepted by the API but
		// reads back as two turns, and models replayed that history would
		// re-narrate and re-issue the same tool call on the next step --
		// visible in the UI as the assistant repeating its preamble and
		// running a client-executed tool (JavaScript/Python) a second time.
		leadingText := textBuf
		textBuf = ""
		flushAttachmentsOnly()

		toolName := strings.TrimPrefix(p.Type, "tool-")
		args := p.Input
		if len(args) == 0 {
			args = json.RawMessage("{}")
		}
		out = append(out, bifrostai.Message{
			Role:      role,
			Text:      leadingText,
			ToolCalls: []bifrostai.ToolCall{{ID: p.ToolCallID, Name: toolName, Arguments: string(args)}},
		})

		resultText := p.ErrorText
		if p.State == "output-available" {
			resultText = stringifyToolOutput(p.Output)
		}
		out = append(out, bifrostai.Message{Role: bifrostai.RoleTool, ToolCallID: p.ToolCallID, Text: resultText})
	}
	flushText()
	return out
}

// uiOnlyPrefix marks output fields the browser renders and the model must
// never be charged for.
//
// A tool's result has two readers with opposite budgets. The model needs the
// smallest honest observation -- edit_file deliberately does not echo the
// file back, because a full re-read per edit is how an agent burns its
// context window. A reviewer needs the opposite: the whole file, to see the
// change in the place it landed. One field prefix lets a tool serve both
// without the UI having to re-fetch state that no longer exists (the "before"
// side of an edit is gone from disk the moment it applies).
//
// This is the only chokepoint where a tool output becomes model-visible text,
// which is what makes the convention enforceable rather than a rule each tool
// has to remember.
const uiOnlyPrefix = "ui_"

// stringifyToolOutput renders a tool's output JSON as the plain text a
// ChatMessageContent.ContentStr expects: a JSON string value (e.g.
// visualization tools' `"Success"`) unwraps to its literal text; anything
// else (an object, array, number) is forwarded as its raw JSON text, which
// every provider accepts as tool-result content -- minus any `ui_` field.
func stringifyToolOutput(raw json.RawMessage) string {
	if len(raw) == 0 {
		return ""
	}
	var s string
	if err := json.Unmarshal(raw, &s); err == nil {
		return s
	}
	return string(stripUIOnlyFields(raw))
}

// stripUIOnlyFields removes top-level `ui_` keys from a JSON object.
//
// Prefiltered on the raw bytes so the overwhelming majority of tool results
// -- which carry no such field -- never pay for a decode and re-encode.
func stripUIOnlyFields(raw json.RawMessage) json.RawMessage {
	if !bytes.Contains(raw, []byte(`"`+uiOnlyPrefix)) {
		return raw
	}
	var fields map[string]json.RawMessage
	if err := json.Unmarshal(raw, &fields); err != nil {
		return raw
	}
	found := false
	for key := range fields {
		if strings.HasPrefix(key, uiOnlyPrefix) {
			delete(fields, key)
			found = true
		}
	}
	if !found {
		return raw
	}
	// A failure here would send the model a Go error string in place of its
	// tool result, which is far worse than sending it a few unnecessary
	// tokens, so the original stands if re-encoding somehow fails.
	stripped, err := json.Marshal(fields)
	if err != nil {
		return raw
	}
	return stripped
}

// dbMessageToEngines converts a persisted models.ChatMessage the same way,
// unmarshalling its stored Parts blob first.
func dbMessageToEngines(m models.ChatMessage) []bifrostai.Message {
	var parts []json.RawMessage
	_ = json.Unmarshal(m.Parts, &parts)
	return uiMessage{ID: m.ID, Role: m.Role, Parts: parts}.toEngineMessages()
}

package bifrostai

import (
	"context"
	"errors"
	"fmt"
	"strings"

	bifrost "github.com/maximhq/bifrost/core"
	"github.com/maximhq/bifrost/core/schemas"

	"betterchatbot/backend/internal/secrets"
)

// MessageRole is the subset of schemas.ChatMessageRole a chat/title/
// temporary request needs. The "developer" role isn't reachable without a
// feature that actually sends one.
type MessageRole string

const (
	RoleSystem    MessageRole = "system"
	RoleUser      MessageRole = "user"
	RoleAssistant MessageRole = "assistant"
	RoleTool      MessageRole = "tool"
)

// ToolCall is one function call an assistant turn made, ported from
// schemas.ChatAssistantMessageToolCall down to the fields a round trip
// needs: enough to both send the call back to the model as history
// (toBifrostMessages) and to execute it (internal/api/chat's tool loop).
// Arguments is the raw JSON-encoded argument object, exactly as the model
// returned it (or as internal/api/chat reconstructed it from a persisted
// UIMessage's tool part `input`).
type ToolCall struct {
	ID        string
	Name      string
	Arguments string
}

// Attachment is one file/image bound to a Message, ported from the
// UIMessage FileUIPart (chat-message-part.ts's `{type:"file", url,
// mediaType, filename}`) internal/api/chat's uiMessage.toEngineMessages
// reads. URL is expected to already be a `data:<mediaType>;base64,...` URL
// -- internal/api/chat resolves it there (attachments.go) before this
// package ever sees it, since the desktop backend's own local storage URLs
// (127.0.0.1:<port>/storage/...) are never reachable by a real cloud
// provider the way a public S3/CDN URL (better-chatbot's only storage
// backends) would be.
type Attachment struct {
	URL       string
	MediaType string
	Filename  string
}

// Message is one chat turn. A plain user/assistant/system turn only ever
// sets Text (optionally with Attachments -- see toBifrostMessage). An
// assistant turn that called a tool sets ToolCalls instead (Text is
// usually empty alongside tool calls, matching how a model's "tool_calls"
// finish reason carries no content); the corresponding result is a
// separate RoleTool message with ToolCallID and Text set to the tool's
// output.
type Message struct {
	Role        MessageRole
	Text        string
	Attachments []Attachment
	ToolCalls   []ToolCall
	ToolCallID  string
}

// Usage ports the subset of LanguageModelUsage (the "ai" package type
// ChatMetadata.usage stores) that BifrostLLMUsage actually reports.
type Usage struct {
	PromptTokens     int
	CompletionTokens int
	TotalTokens      int
}

// Chunk is one event off a Client.Stream channel. At most one of TextDelta,
// Usage, or Err is meaningful per chunk; Err, when set, is always the last
// value sent before the channel closes.
type Chunk struct {
	TextDelta string
	Usage     *Usage
	Err       error
}

// Client wraps *bifrost.Bifrost with the text-only streaming call shape
// Phase 3's chat routes need. Ported from spike/bifrost/main.go's proof
// that bifrost.Init + ChatCompletionStreamRequest work end to end; that
// spike is deleted now that this is its real home.
type Client struct {
	bf *bifrost.Bifrost
}

// NewClient calls bifrost.Init with an Account backed by store, registering
// every catalog provider (account.go).
func NewClient(ctx context.Context, store secrets.KeyStore) (*Client, error) {
	bf, err := bifrost.Init(ctx, schemas.BifrostConfig{Account: newAccount(store)})
	if err != nil {
		return nil, fmt.Errorf("bifrost.Init: %w", err)
	}
	return &Client{bf: bf}, nil
}

// Shutdown releases the underlying Bifrost client's resources.
func (c *Client) Shutdown() {
	c.bf.Shutdown()
}

// Stream sends system+messages to resolved.Provider/BifrostModel and
// returns a channel of incremental chunks, closed once the stream ends
// (normally or on error). ctx governs the whole call, including the
// upstream provider request -- pass the HTTP request's context so a client
// disconnect cancels it too, the same way request.signal does in the TS
// route handlers.
func (c *Client) Stream(ctx context.Context, resolved ResolvedModel, system string, messages []Message) (<-chan Chunk, error) {
	bctx := schemas.NewBifrostContext(ctx, schemas.NoDeadline)
	req := &schemas.BifrostChatRequest{
		Provider: resolved.Provider,
		Model:    resolved.BifrostModel,
		Input:    toBifrostMessages(system, messages),
	}

	stream, bErr := c.bf.ChatCompletionStreamRequest(bctx, req)
	if bErr != nil {
		return nil, toError(bErr)
	}

	out := make(chan Chunk)
	go func() {
		defer close(out)
		for sc := range stream {
			if sc == nil {
				continue
			}
			if sc.BifrostError != nil {
				out <- Chunk{Err: toError(sc.BifrostError)}
				return
			}
			if sc.BifrostChatResponse == nil {
				continue
			}
			for _, choice := range sc.BifrostChatResponse.Choices {
				if choice.ChatStreamResponseChoice == nil || choice.ChatStreamResponseChoice.Delta == nil {
					continue
				}
				if content := choice.ChatStreamResponseChoice.Delta.Content; content != nil && *content != "" {
					out <- Chunk{TextDelta: *content}
				}
			}
			if u := sc.BifrostChatResponse.Usage; u != nil {
				out <- Chunk{Usage: &Usage{
					PromptTokens:     u.PromptTokens,
					CompletionTokens: u.CompletionTokens,
					TotalTokens:      u.TotalTokens,
				}}
			}
		}
	}()
	return out, nil
}

func toBifrostMessages(system string, messages []Message) []schemas.ChatMessage {
	out := make([]schemas.ChatMessage, 0, len(messages)+1)
	if system != "" {
		s := system
		out = append(out, schemas.ChatMessage{
			Role:    schemas.ChatMessageRoleSystem,
			Content: &schemas.ChatMessageContent{ContentStr: &s},
		})
	}
	for _, m := range messages {
		out = append(out, toBifrostMessage(m))
	}
	return out
}

func toBifrostMessage(m Message) schemas.ChatMessage {
	text := m.Text

	if m.Role == RoleTool {
		id := m.ToolCallID
		return schemas.ChatMessage{
			Role:            schemas.ChatMessageRoleTool,
			Content:         &schemas.ChatMessageContent{ContentStr: &text},
			ChatToolMessage: &schemas.ChatToolMessage{ToolCallID: &id},
		}
	}

	if len(m.ToolCalls) > 0 {
		calls := make([]schemas.ChatAssistantMessageToolCall, len(m.ToolCalls))
		for i, tc := range m.ToolCalls {
			id, name := tc.ID, tc.Name
			calls[i] = schemas.ChatAssistantMessageToolCall{
				Index: uint16(i),
				ID:    &id,
				Function: schemas.ChatAssistantMessageToolCallFunction{
					Name:      &name,
					Arguments: tc.Arguments,
				},
			}
		}
		msg := schemas.ChatMessage{
			Role:                 schemas.ChatMessageRoleAssistant,
			ChatAssistantMessage: &schemas.ChatAssistantMessage{ToolCalls: calls},
		}
		if text != "" {
			msg.Content = &schemas.ChatMessageContent{ContentStr: &text}
		}
		return msg
	}

	role := schemas.ChatMessageRoleUser
	switch m.Role {
	case RoleAssistant:
		role = schemas.ChatMessageRoleAssistant
	case RoleSystem:
		role = schemas.ChatMessageRoleSystem
	}

	if len(m.Attachments) > 0 {
		return schemas.ChatMessage{Role: role, Content: &schemas.ChatMessageContent{ContentBlocks: attachmentBlocks(text, m.Attachments)}}
	}
	return schemas.ChatMessage{
		Role:    role,
		Content: &schemas.ChatMessageContent{ContentStr: &text},
	}
}

// attachmentBlocks ports convertToModelMessages' handling of interleaved
// text/file UIMessage parts as one multi-part provider message: a leading
// text block (when there's any text at all) followed by one block per
// attachment -- an image/* mediaType becomes an image_url block (vision
// input), anything else becomes a generic file block (document input, on
// models that support it; providers that don't just ignore/reject it the
// same way they would with the TS SDK).
func attachmentBlocks(text string, attachments []Attachment) []schemas.ChatContentBlock {
	blocks := make([]schemas.ChatContentBlock, 0, len(attachments)+1)
	if text != "" {
		t := text
		blocks = append(blocks, schemas.ChatContentBlock{Type: schemas.ChatContentBlockTypeText, Text: &t})
	}
	for _, a := range attachments {
		url := a.URL
		if isImageMediaType(a.MediaType) {
			blocks = append(blocks, schemas.ChatContentBlock{
				Type:           schemas.ChatContentBlockTypeImage,
				ImageURLStruct: &schemas.ChatInputImage{URL: url},
			})
			continue
		}
		filename := a.Filename
		blocks = append(blocks, schemas.ChatContentBlock{
			Type: schemas.ChatContentBlockTypeFile,
			File: &schemas.ChatInputFile{FileData: &url, Filename: &filename},
		})
	}
	return blocks
}

func isImageMediaType(mediaType string) bool {
	return strings.HasPrefix(mediaType, "image/")
}

func toError(be *schemas.BifrostError) error {
	if be == nil {
		return errors.New("bifrost: unknown error")
	}
	if be.Error != nil && be.Error.Message != "" {
		return errors.New(be.Error.Message)
	}
	return errors.New("bifrost: request failed")
}

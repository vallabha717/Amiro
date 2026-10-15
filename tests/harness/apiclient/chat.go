package apiclient

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"time"

	"amiro/tests/harness/logging"
)

// ChatModel names a provider/model pair the way the request body does.
type ChatModel struct {
	Provider string `json:"provider"`
	Model    string `json:"model"`
}

// Mention is an @-reference in a message: an MCP tool, a skill
// or one of Amiro's own tools.
type Mention struct {
	Type     string `json:"type"`
	Name     string `json:"name"`
	ServerID string `json:"serverId,omitempty"`
}

// ChatRequest is POST /api/chat's body, transcribed from
// internal/api/chat/route.go's chatRequest.
type ChatRequest struct {
	// ID is the THREAD id, not a message id. chat.RunTurn creates the
	// thread on first use, so a caller mints a uuid and sends it; there is
	// no "create thread" route to call first.
	ID                       string                     `json:"id"`
	Message                  ChatMessage                `json:"message"`
	ChatModel                *ChatModel                 `json:"chatModel,omitempty"`
	ToolChoice               string                     `json:"toolChoice,omitempty"`
	Mentions                 []Mention                  `json:"mentions,omitempty"`
	AllowedAppDefaultToolkit *[]string                  `json:"allowedAppDefaultToolkit,omitempty"`
	AllowedMcpServers        map[string]AllowedMCPTools `json:"allowedMcpServers,omitempty"`
	PermissionMode           string                     `json:"permissionMode,omitempty"`
	WorkspaceRoot            string                     `json:"workspaceRoot,omitempty"`
	ProjectDir               string                     `json:"projectDir,omitempty"`
	CompactNow               bool                       `json:"compactNow,omitempty"`
}

type AllowedMCPTools struct {
	Tools []string `json:"tools"`
}

// ChatMessage is one UI message: an id, a role, and a list of parts whose
// shapes vary by type.
type ChatMessage struct {
	ID       string            `json:"id"`
	Role     string            `json:"role"`
	Parts    []json.RawMessage `json:"parts"`
	Metadata json.RawMessage   `json:"metadata,omitempty"`
}

// TextMessage builds the ordinary case: one user message of plain text.
func TextMessage(id, text string) ChatMessage {
	part, _ := json.Marshal(map[string]string{"type": "text", "text": text})
	return ChatMessage{ID: id, Role: "user", Parts: []json.RawMessage{part}}
}

// Chat opens a streaming turn. The caller owns the returned Stream and must
// Close it.
//
// This does not go through Do(): the response is a stream, and reading it
// into memory to log it would defeat the point of streaming and would also
// make a hung turn produce no artifacts at all.
func (c *Client) Chat(ctx context.Context, req ChatRequest) (*Stream, error) {
	body, err := json.Marshal(req)
	if err != nil {
		return nil, err
	}
	httpReq, err := http.NewRequestWithContext(ctx, http.MethodPost, c.BaseURL+"/api/chat", bytes.NewReader(body))
	if err != nil {
		return nil, err
	}
	httpReq.Header.Set("Content-Type", "application/json")
	httpReq.Header.Set("Accept", "text/event-stream")
	c.authorize(httpReq)

	started := time.Now()
	resp, err := c.http.Do(httpReq)
	if err != nil {
		c.record(http.MethodPost, "/api/chat", 0, time.Since(started), body, nil, err)
		return nil, fmt.Errorf("POST /api/chat: %w", err)
	}
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		defer resp.Body.Close()
		errBody := make([]byte, 8<<10)
		n, _ := resp.Body.Read(errBody)
		errBody = errBody[:n]
		c.record(http.MethodPost, "/api/chat", resp.StatusCode, time.Since(started), body, errBody, nil)
		return nil, &Error{Method: http.MethodPost, Path: "/api/chat", Status: resp.StatusCode,
			Message: messageOf(errBody), Body: string(errBody)}
	}
	c.record(http.MethodPost, "/api/chat", resp.StatusCode, time.Since(started), body, nil, nil)

	// Every frame lands on the merged timeline as it arrives, which is what
	// makes "the browser clicked, the backend got it, frames came back, the
	// DOM never updated" readable from one file.
	onFrame := func(f Frame) {
		if c.log == nil {
			return
		}
		detail := map[string]any{"type": string(f.Type)}
		if f.Delta != "" {
			detail["len"] = len(f.Delta)
		}
		if f.ToolName != "" {
			detail["tool"] = f.ToolName
		}
		c.log.Emit(logging.Event{Surface: c.surface, Test: c.address, Kind: logging.KindStream,
			Msg: "frame", Detail: detail})
	}
	return NewStream(resp.Body, onFrame), nil
}

// ChatTurn is Chat plus Collect: send one message, get the whole answer.
func (c *Client) ChatTurn(ctx context.Context, req ChatRequest) (Turn, error) {
	stream, err := c.Chat(ctx, req)
	if err != nil {
		return Turn{}, err
	}
	defer stream.Close()
	return stream.Collect()
}

// Model is one entry of GET /api/chat/models.
type Model struct {
	Provider string          `json:"provider"`
	Models   json.RawMessage `json:"models"`
}

func (c *Client) Models(ctx context.Context) (json.RawMessage, error) {
	var out json.RawMessage
	err := c.Get(ctx, "/api/chat/models", &out)
	return out, err
}

func (c *Client) GenerateTitle(ctx context.Context, req any) (*Stream, error) {
	body, err := json.Marshal(req)
	if err != nil {
		return nil, err
	}
	httpReq, err := http.NewRequestWithContext(ctx, http.MethodPost, c.BaseURL+"/api/chat/title", bytes.NewReader(body))
	if err != nil {
		return nil, err
	}
	httpReq.Header.Set("Content-Type", "application/json")
	httpReq.Header.Set("Accept", "text/event-stream")
	c.authorize(httpReq)

	started := time.Now()
	resp, err := c.http.Do(httpReq)
	if err != nil {
		c.record(http.MethodPost, "/api/chat/title", 0, time.Since(started), body, nil, err)
		return nil, fmt.Errorf("POST /api/chat/title: %w", err)
	}
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		defer resp.Body.Close()
		errBody := make([]byte, 8<<10)
		n, _ := resp.Body.Read(errBody)
		errBody = errBody[:n]
		c.record(http.MethodPost, "/api/chat/title", resp.StatusCode, time.Since(started), body, errBody, nil)
		return nil, &Error{Method: http.MethodPost, Path: "/api/chat/title", Status: resp.StatusCode,
			Message: messageOf(errBody), Body: string(errBody)}
	}
	c.record(http.MethodPost, "/api/chat/title", resp.StatusCode, time.Since(started), body, nil, nil)

	onFrame := func(f Frame) {
		if c.log == nil {
			return
		}
		c.log.Emit(logging.Event{
			Surface: c.surface,
			Test:    c.address,
			Kind:    logging.KindStream,
			Msg:     string(f.Type),
			Detail:  map[string]any{"type": string(f.Type)},
		})
	}
	return NewStream(resp.Body, onFrame), nil
}

// ExportThread publishes a thread as a shareable export, returning the export ID.
func (c *Client) ExportThread(ctx context.Context, threadID string, expiresAt *time.Time) (string, error) {
	body := map[string]any{"threadId": threadID}
	if expiresAt != nil {
		body["expiresAt"] = expiresAt
	}
	var exportID string
	err := c.Post(ctx, "/api/chat/export", body, &exportID)
	return exportID, err
}

// TemporaryChat opens a streaming turn that leaves no persisted thread.
func (c *Client) TemporaryChat(ctx context.Context, req any) (*Stream, error) {
	body, err := json.Marshal(req)
	if err != nil {
		return nil, err
	}
	httpReq, err := http.NewRequestWithContext(ctx, http.MethodPost, c.BaseURL+"/api/chat/temporary", bytes.NewReader(body))
	if err != nil {
		return nil, err
	}
	httpReq.Header.Set("Content-Type", "application/json")
	httpReq.Header.Set("Accept", "text/event-stream")
	c.authorize(httpReq)

	started := time.Now()
	resp, err := c.http.Do(httpReq)
	if err != nil {
		c.record(http.MethodPost, "/api/chat/temporary", 0, time.Since(started), body, nil, err)
		return nil, fmt.Errorf("POST /api/chat/temporary: %w", err)
	}
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		defer resp.Body.Close()
		errBody := make([]byte, 8<<10)
		n, _ := resp.Body.Read(errBody)
		errBody = errBody[:n]
		c.record(http.MethodPost, "/api/chat/temporary", resp.StatusCode, time.Since(started), body, errBody, nil)
		return nil, &Error{Method: http.MethodPost, Path: "/api/chat/temporary", Status: resp.StatusCode,
			Message: messageOf(errBody), Body: string(errBody)}
	}
	c.record(http.MethodPost, "/api/chat/temporary", resp.StatusCode, time.Since(started), body, nil, nil)

	onFrame := func(f Frame) {
		if c.log == nil {
			return
		}
		c.log.Emit(logging.Event{
			Surface: c.surface,
			Test:    c.address,
			Kind:    logging.KindStream,
			Msg:     string(f.Type),
			Detail:  map[string]any{"type": string(f.Type)},
		})
	}
	return NewStream(resp.Body, onFrame), nil
}

// OpenAIRealtime establishes or probes the realtime voice endpoint.
func (c *Client) OpenAIRealtime(ctx context.Context, body any) (json.RawMessage, error) {
	var out json.RawMessage
	err := c.Post(ctx, "/api/chat/openai-realtime", body, &out)
	return out, err
}

// GenerateObject is POST /api/ai/generate-object.
func (c *Client) GenerateObject(ctx context.Context, body any) (json.RawMessage, error) {
	var out json.RawMessage
	err := c.Post(ctx, "/api/ai/generate-object", body, &out)
	return out, err
}

// GenerateExampleToolSchema is POST /api/ai/generate-example-tool-schema.
func (c *Client) GenerateExampleToolSchema(ctx context.Context, body any) (json.RawMessage, error) {
	var out json.RawMessage
	err := c.Post(ctx, "/api/ai/generate-example-tool-schema", body, &out)
	return out, err
}


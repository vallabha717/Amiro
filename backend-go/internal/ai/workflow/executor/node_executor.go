// Package executor ports src/lib/ai/workflow/executor/**: the per-kind node
// executors, the runtime state store, and the graph engine that runs a
// workflow from its Input node to completion, emitting the same WF_EVENT
// wire events the existing frontend (execute-tab.tsx) already parses.
package executor

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	neturl "net/url"
	"strconv"
	"strings"
	"time"

	bifrostai "betterchatbot/backend/internal/ai/bifrost"
	"betterchatbot/backend/internal/ai/workflow"
	"betterchatbot/backend/internal/db/models"
)

// Engine is the subset of *bifrostai.Client the LLM/Tool node executors
// call, narrowed to an interface so this package's own tests -- and
// internal/api/workflow's handler tests -- can substitute a fake instead of
// a real Bifrost client + real provider keys, the same pattern
// internal/api/chat.Engine already established for the chat routes.
type Engine interface {
	Generate(ctx context.Context, resolved bifrostai.ResolvedModel, system string, messages []bifrostai.Message) (*bifrostai.GenerateResult, error)
	GenerateObject(ctx context.Context, resolved bifrostai.ResolvedModel, system string, messages []bifrostai.Message, schema json.RawMessage) (json.RawMessage, *bifrostai.Usage, error)
	GenerateWithTool(ctx context.Context, resolved bifrostai.ResolvedModel, prompt string, toolName, toolDescription string, paramSchema json.RawMessage) (json.RawMessage, error)
}

// MCPCaller is the subset of *mcp.Manager a Tool node's mcp-tool call
// needs. Narrowed to an interface for the same fakeability reason as
// Engine -- and to avoid this package importing internal/mcp at all just
// for one method.
type MCPCaller interface {
	CallTool(ctx context.Context, id, toolName string, args json.RawMessage) bifrostai.MCPToolCallResult
}

// NodeContext bundles a node's own row with every external dependency its
// executor might need, mirroring node-executor.ts's NodeExecutor<T> closing
// over `customModelProvider`/`mcpClientsManager` at module scope -- Go has
// no module-scope singletons here, so they're threaded through explicitly.
type NodeContext struct {
	Ctx     context.Context
	Node    models.WorkflowNode
	State   *State
	Bifrost Engine
	MCP     MCPCaller
}

// NodeResult ports NodeExecutor's return shape (node-executor.ts:42-53).
type NodeResult struct {
	Input  interface{}
	Output interface{}
}

func decodeConfig(node models.WorkflowNode, out interface{}) error {
	if len(node.NodeConfig) == 0 {
		return nil
	}
	return json.Unmarshal(node.NodeConfig, out)
}

// executeInput ports inputNodeExecutor (node-executor.ts:59).
func executeInput(nctx NodeContext) (NodeResult, []string, error) {
	return NodeResult{Output: nctx.State.Query}, nil, nil
}

// executeOutput ports outputNodeExecutor (node-executor.ts:70).
func executeOutput(nctx NodeContext) (NodeResult, []string, error) {
	var cfg workflow.OutputNodeConfig
	if err := decodeConfig(nctx.Node, &cfg); err != nil {
		return NodeResult{}, nil, err
	}
	out := make(map[string]interface{}, len(cfg.OutputData))
	for _, item := range cfg.OutputData {
		if item.Source == nil {
			continue
		}
		out[item.Key] = nctx.State.GetOutput(*item.Source)
	}
	return NodeResult{Output: out}, nil, nil
}

// executeLLM ports llmNodeExecutor (node-executor.ts:90).
func executeLLM(nctx NodeContext) (NodeResult, []string, error) {
	var cfg workflow.LLMNodeConfig
	if err := decodeConfig(nctx.Node, &cfg); err != nil {
		return NodeResult{}, nil, err
	}
	resolved := bifrostai.Resolve(cfg.Model.Provider, cfg.Model.Model)

	messages := make([]bifrostai.Message, 0, len(cfg.Messages))
	for _, m := range cfg.Messages {
		messages = append(messages, workflow.ConvertTiptapJSONToMessage(m.Role, m.Content, nctx.State.GetOutput))
	}

	isTextResponse := outputSchemaAnswerIsString(cfg.OutputSchema)

	nctx.State.SetInput(nctx.Node.ID, map[string]interface{}{
		"chatModel":      cfg.Model,
		"messages":       messages,
		"responseFormat": responseFormatLabel(isTextResponse),
	})

	if isTextResponse {
		res, err := nctx.Bifrost.Generate(nctx.Ctx, resolved, "", messages)
		if err != nil {
			return NodeResult{}, nil, err
		}
		return NodeResult{Output: map[string]interface{}{
			"totalTokens": usageTotal(res.Usage),
			"answer":      res.Text,
		}}, nil, nil
	}

	answerSchema := extractAnswerSchema(cfg.OutputSchema)
	raw, usage, err := nctx.Bifrost.GenerateObject(nctx.Ctx, resolved, "", messages, answerSchema)
	if err != nil {
		return NodeResult{}, nil, err
	}
	var answer interface{}
	if err := json.Unmarshal(raw, &answer); err != nil {
		return NodeResult{}, nil, err
	}
	return NodeResult{Output: map[string]interface{}{
		"totalTokens": usageTotal(usage),
		"answer":      answer,
	}}, nil, nil
}

func responseFormatLabel(isText bool) string {
	if isText {
		return "text"
	}
	return "object"
}

func usageTotal(u *bifrostai.Usage) int {
	if u == nil {
		return 0
	}
	return u.TotalTokens
}

func outputSchemaAnswerIsString(raw json.RawMessage) bool {
	if len(raw) == 0 {
		return false
	}
	var schema struct {
		Properties struct {
			Answer struct {
				Type string `json:"type"`
			} `json:"answer"`
		} `json:"properties"`
	}
	_ = json.Unmarshal(raw, &schema)
	return schema.Properties.Answer.Type == "string"
}

func extractAnswerSchema(raw json.RawMessage) json.RawMessage {
	if len(raw) == 0 {
		return nil
	}
	var schema struct {
		Properties map[string]json.RawMessage `json:"properties"`
	}
	if err := json.Unmarshal(raw, &schema); err != nil {
		return nil
	}
	return schema.Properties["answer"]
}

// executeCondition ports conditionNodeExecutor (node-executor.ts:147). It
// also computes the chosen branch's target node ids directly (the second
// return value), since this engine routes by that return instead of
// round-tripping a "nextNodes" field through the output store the way
// ts-edge's dynamicEdge callback did.
func executeCondition(nctx NodeContext) (NodeResult, []string, error) {
	var cfg workflow.ConditionNodeConfig
	if err := decodeConfig(nctx.Node, &cfg); err != nil {
		return NodeResult{}, nil, err
	}

	candidates := append([]workflow.ConditionBranch{cfg.Branches.If}, cfg.Branches.ElseIf...)
	chosen := cfg.Branches.Else
	for _, branch := range candidates {
		if workflow.CheckConditionBranch(branch, nctx.State.GetOutput) {
			chosen = branch
			break
		}
	}

	var next []string
	for _, e := range nctx.State.Edges {
		if e.Source != nctx.Node.ID {
			continue
		}
		if edgeSourceHandle(e) != chosen.ID {
			continue
		}
		next = append(next, e.Target)
	}

	return NodeResult{Output: map[string]interface{}{
		"type":   chosen.Type,
		"branch": chosen.ID,
	}}, next, nil
}

func edgeSourceHandle(e models.WorkflowEdge) string {
	var cfg struct {
		SourceHandle string `json:"sourceHandle"`
	}
	_ = json.Unmarshal(e.UIConfig, &cfg)
	return cfg.SourceHandle
}

// executeTool ports toolNodeExecutor (node-executor.ts:184).
func executeTool(nctx NodeContext) (NodeResult, []string, error) {
	var cfg workflow.ToolNodeConfig
	if err := decodeConfig(nctx.Node, &cfg); err != nil {
		return NodeResult{}, nil, err
	}
	if cfg.Tool == nil {
		return NodeResult{}, nil, errors.New("Tool not found")
	}

	var argsJSON json.RawMessage
	input := map[string]interface{}{}
	if len(cfg.Tool.ParameterSchema) == 0 {
		input["parameter"] = nil
	} else {
		var prompt string
		if len(cfg.Message) > 0 {
			prompt = workflow.ConvertTiptapJSONToMessage("user", cfg.Message, nctx.State.GetOutput).Text
		}
		resolved := bifrostai.Resolve(cfg.Model.Provider, cfg.Model.Model)
		args, err := nctx.Bifrost.GenerateWithTool(nctx.Ctx, resolved, prompt, cfg.Tool.ID, cfg.Tool.Description, cfg.Tool.ParameterSchema)
		if err != nil {
			return NodeResult{}, nil, err
		}
		argsJSON = args
		if len(args) > 0 {
			var parsed interface{}
			_ = json.Unmarshal(args, &parsed)
			input["parameter"] = parsed
		} else {
			input["parameter"] = nil
		}
		input["prompt"] = prompt
	}

	var output map[string]interface{}
	switch cfg.Tool.Type {
	case "mcp-tool":
		if nctx.MCP == nil {
			return NodeResult{}, nil, errors.New("MCP is not configured")
		}
		result := nctx.MCP.CallTool(nctx.Ctx, cfg.Tool.ServerID, cfg.Tool.ID, argsJSON)
		if result.IsError {
			msg := result.Error
			if msg == "" {
				msg = result.Content
			}
			if msg == "" {
				msg = "mcp tool call failed"
			}
			return NodeResult{}, nil, errors.New(msg)
		}
		output = map[string]interface{}{"tool_result": result}
	case "app-tool":
		var toolResult interface{}
		var raw json.RawMessage
		var err error
		switch cfg.Tool.ID {
		case "webContent":
			raw, err = workflow.ExaContentsForWorkflow(nctx.Ctx, argsJSON)
		case "webSearch":
			raw, err = workflow.ExaSearchForWorkflow(nctx.Ctx, argsJSON)
		default:
			toolResult = "Unknown tool"
		}
		if err != nil {
			return NodeResult{}, nil, err
		}
		if raw != nil {
			var parsed interface{}
			_ = json.Unmarshal(raw, &parsed)
			toolResult = parsed
		}
		output = map[string]interface{}{"tool_result": toolResult}
	default:
		output = map[string]interface{}{"tool_result": map[string]interface{}{
			"error": fmt.Sprintf("Not implemented %q", cfg.Tool.Type),
		}}
	}

	return NodeResult{Input: input, Output: output}, nil, nil
}

// resolveHTTPValue ports resolveHttpValue (node-executor.ts:282).
func resolveHTTPValue(v *workflow.HttpValue, getOutput workflow.GetOutputFunc) string {
	if v == nil {
		return ""
	}
	if v.Literal != nil {
		return *v.Literal
	}
	if v.Source == nil {
		return ""
	}
	out := getOutput(*v.Source)
	switch t := out.(type) {
	case nil:
		return ""
	case string:
		return t
	case float64:
		return strconv.FormatFloat(t, 'f', -1, 64)
	default:
		b, _ := json.Marshal(out)
		return string(b)
	}
}

// executeHTTP ports httpNodeExecutor (node-executor.ts:312).
func executeHTTP(nctx NodeContext) (NodeResult, []string, error) {
	var cfg workflow.HttpNodeConfig
	if err := decodeConfig(nctx.Node, &cfg); err != nil {
		return NodeResult{}, nil, err
	}

	timeoutMs := 30000
	if cfg.Timeout != nil && *cfg.Timeout > 0 {
		timeoutMs = *cfg.Timeout
	}

	url := resolveHTTPValue(cfg.URL, nctx.State.GetOutput)
	if url == "" {
		return NodeResult{}, nil, errors.New("HTTP node requires a URL")
	}

	query := neturl.Values{}
	for _, q := range cfg.Query {
		if q.Key == "" || q.Value == nil {
			continue
		}
		if v := resolveHTTPValue(q.Value, nctx.State.GetOutput); v != "" {
			query.Add(q.Key, v)
		}
	}
	finalURL := url
	if len(query) > 0 {
		sep := "?"
		if strings.Contains(url, "?") {
			sep = "&"
		}
		finalURL = url + sep + query.Encode()
	}

	headers := map[string]string{}
	for _, h := range cfg.Headers {
		if h.Key == "" || h.Value == nil {
			continue
		}
		if v := resolveHTTPValue(h.Value, nctx.State.GetOutput); v != "" {
			headers[h.Key] = v
		}
	}

	method := cfg.Method
	var body string
	if cfg.Body != nil && (method == "POST" || method == "PUT" || method == "PATCH") {
		body = resolveHTTPValue(cfg.Body, nctx.State.GetOutput)
		if body != "" && !hasHeaderCaseInsensitive(headers, "content-type") {
			if json.Valid([]byte(body)) {
				headers["Content-Type"] = "application/json"
			} else {
				headers["Content-Type"] = "text/plain"
			}
		}
	}

	startTime := time.Now()
	requestSnapshot := map[string]interface{}{
		"url": finalURL, "method": method, "headers": headers, "body": body, "timeout": timeoutMs,
	}

	reqCtx, cancel := context.WithTimeout(nctx.Ctx, time.Duration(timeoutMs)*time.Millisecond)
	defer cancel()

	var bodyReader io.Reader
	if body != "" {
		bodyReader = strings.NewReader(body)
	}
	req, err := http.NewRequestWithContext(reqCtx, method, finalURL, bodyReader)
	if err != nil {
		return NodeResult{}, nil, err
	}
	for k, v := range headers {
		req.Header.Set(k, v)
	}

	resp, doErr := http.DefaultClient.Do(req)
	duration := time.Since(startTime).Milliseconds()
	if doErr != nil {
		errType, errMessage := classifyHTTPError(doErr, timeoutMs)
		nctx.State.SetInput(nctx.Node.ID, map[string]interface{}{
			"request": requestSnapshot,
			"response": map[string]interface{}{
				"status": 0, "statusText": errMessage, "ok": false,
				"headers": map[string]string{}, "body": "", "duration": duration,
				"error": map[string]interface{}{"type": errType, "message": errMessage},
			},
		})
		return NodeResult{}, nil, errors.New(errMessage)
	}
	defer resp.Body.Close()

	respBody, _ := io.ReadAll(resp.Body)
	respHeaders := map[string]string{}
	for k := range resp.Header {
		respHeaders[strings.ToLower(k)] = resp.Header.Get(k)
	}
	var size interface{}
	if cl := resp.Header.Get("Content-Length"); cl != "" {
		if n, err := strconv.Atoi(cl); err == nil {
			size = n
		}
	}
	ok := resp.StatusCode >= 200 && resp.StatusCode < 300
	responseSnapshot := map[string]interface{}{
		"status": resp.StatusCode, "statusText": resp.Status, "ok": ok,
		"headers": respHeaders, "body": string(respBody), "duration": duration, "size": size,
	}

	if !ok {
		nctx.State.SetInput(nctx.Node.ID, map[string]interface{}{
			"request": requestSnapshot, "response": responseSnapshot,
		})
		return NodeResult{}, nil, fmt.Errorf("%d %s", resp.StatusCode, resp.Status)
	}

	return NodeResult{
		Input:  map[string]interface{}{"request": requestSnapshot},
		Output: map[string]interface{}{"response": responseSnapshot},
	}, nil, nil
}

func hasHeaderCaseInsensitive(headers map[string]string, key string) bool {
	for k := range headers {
		if strings.EqualFold(k, key) {
			return true
		}
	}
	return false
}

// classifyHTTPError is a best-effort port of httpNodeExecutor's
// AbortError/ENOTFOUND/ECONNREFUSED classification (node-executor.ts:447):
// Go surfaces network failures through different types than Node's fetch,
// so this maps the closest Go equivalents rather than matching 1:1.
func classifyHTTPError(err error, timeoutMs int) (errType, message string) {
	if errors.Is(err, context.DeadlineExceeded) {
		return "timeout", fmt.Sprintf("Request timeout after %dms", timeoutMs)
	}
	var dnsErr *net.DNSError
	if errors.As(err, &dnsErr) {
		return "dns", err.Error()
	}
	var opErr *net.OpError
	if errors.As(err, &opErr) && opErr.Op == "dial" {
		return "connection", err.Error()
	}
	return "unknown", err.Error()
}

// executeTemplate ports templateNodeExecutor (node-executor.ts:485).
func executeTemplate(nctx NodeContext) (NodeResult, []string, error) {
	var cfg workflow.TemplateNodeConfig
	if err := decodeConfig(nctx.Node, &cfg); err != nil {
		return NodeResult{}, nil, err
	}
	var text string
	if cfg.Template.Type == "tiptap" {
		text = workflow.ConvertTiptapJSONToText(cfg.Template.TipTap, nctx.State.GetOutput)
	}
	return NodeResult{Output: map[string]interface{}{"template": text}}, nil, nil
}

// executeNode dispatches by kind, porting getExecutorByKind (workflow-executor.ts:26).
// Note node/Condition node's own event-visible output deliberately drops
// ts-edge's internal-only "nextNodes" field (a wiring artifact of that
// library's dynamicEdge mechanism) -- this engine routes using the second
// return value instead.
func executeNode(nctx NodeContext) (NodeResult, []string, error) {
	switch workflow.NodeKind(nctx.Node.Kind) {
	case workflow.NodeKindInput:
		return executeInput(nctx)
	case workflow.NodeKindOutput:
		return executeOutput(nctx)
	case workflow.NodeKindLLM:
		return executeLLM(nctx)
	case workflow.NodeKindCondition:
		return executeCondition(nctx)
	case workflow.NodeKindTool:
		return executeTool(nctx)
	case workflow.NodeKindHttp:
		return executeHTTP(nctx)
	case workflow.NodeKindTemplate:
		return executeTemplate(nctx)
	default:
		// Matches getExecutorByKind's fallback (workflow-executor.ts:50):
		// an unrecognized kind (including Note, which has no dedicated
		// case in the TS switch either) warns and no-ops rather than
		// failing the whole run.
		return NodeResult{}, nil, nil
	}
}

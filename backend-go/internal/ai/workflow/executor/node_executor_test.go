package executor

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"

	bifrostai "amiro/backend/internal/ai/bifrost"
	"amiro/backend/internal/ai/workflow"
	"amiro/backend/internal/db/models"
)

type fakeEngine struct {
	generateText   string
	generateErr    error
	objectJSON     json.RawMessage
	objectErr      error
	toolArgs       json.RawMessage
	toolErr        error
	lastMessages   []bifrostai.Message
	lastToolPrompt string
}

func (f *fakeEngine) Generate(ctx context.Context, resolved bifrostai.ResolvedModel, system string, messages []bifrostai.Message) (*bifrostai.GenerateResult, error) {
	f.lastMessages = messages
	if f.generateErr != nil {
		return nil, f.generateErr
	}
	return &bifrostai.GenerateResult{Text: f.generateText, Usage: &bifrostai.Usage{TotalTokens: 7}}, nil
}

func (f *fakeEngine) GenerateObject(ctx context.Context, resolved bifrostai.ResolvedModel, system string, messages []bifrostai.Message, schema json.RawMessage) (json.RawMessage, *bifrostai.Usage, error) {
	if f.objectErr != nil {
		return nil, nil, f.objectErr
	}
	return f.objectJSON, &bifrostai.Usage{TotalTokens: 3}, nil
}

func (f *fakeEngine) GenerateWithTool(ctx context.Context, resolved bifrostai.ResolvedModel, prompt string, toolName, toolDescription string, paramSchema json.RawMessage) (json.RawMessage, error) {
	f.lastToolPrompt = prompt
	if f.toolErr != nil {
		return nil, f.toolErr
	}
	return f.toolArgs, nil
}

type fakeMCP struct {
	result bifrostai.MCPToolCallResult
}

func (f *fakeMCP) CallTool(ctx context.Context, id, toolName string, args json.RawMessage) bifrostai.MCPToolCallResult {
	return f.result
}

func nodeWithConfig(t *testing.T, id string, kind workflow.NodeKind, config interface{}) models.WorkflowNode {
	t.Helper()
	b, err := json.Marshal(config)
	if err != nil {
		t.Fatal(err)
	}
	return models.WorkflowNode{ID: id, Kind: string(kind), NodeConfig: b}
}

func TestExecuteInput_ReturnsQuery(t *testing.T) {
	state := NewState(map[string]interface{}{"topic": "go"}, nil, nil)
	nctx := NodeContext{Ctx: context.Background(), Node: node("in", workflow.NodeKindInput), State: state}
	result, next, err := executeNode(nctx)
	if err != nil {
		t.Fatal(err)
	}
	if next != nil {
		t.Fatalf("expected no routing override, got %v", next)
	}
	m := result.Output.(map[string]interface{})
	if m["topic"] != "go" {
		t.Fatalf("got %v", result.Output)
	}
}

func TestExecuteOutput_CollectsFromSources(t *testing.T) {
	state := NewState(nil, nil, nil)
	state.SetOutput("llm1", map[string]interface{}{"answer": "42"})
	n := nodeWithConfig(t, "out", workflow.NodeKindOutput, workflow.OutputNodeConfig{
		OutputData: []workflow.OutputDataItem{
			{Key: "result", Source: &workflow.OutputSchemaSourceKey{NodeID: "llm1", Path: []string{"answer"}}},
		},
	})
	result, _, err := executeNode(NodeContext{Ctx: context.Background(), Node: n, State: state})
	if err != nil {
		t.Fatal(err)
	}
	m := result.Output.(map[string]interface{})
	if m["result"] != "42" {
		t.Fatalf("got %v", result.Output)
	}
}

func TestExecuteLLM_TextResponse(t *testing.T) {
	state := NewState(nil, nil, nil)
	n := nodeWithConfig(t, "llm1", workflow.NodeKindLLM, workflow.LLMNodeConfig{
		Model:    workflow.ChatModelRef{Provider: "openai", Model: "gpt-4o"},
		Messages: []workflow.LLMMessage{{Role: "user"}},
		OutputSchema: json.RawMessage(`{
			"type":"object","properties":{"answer":{"type":"string"},"totalTokens":{"type":"number"}}
		}`),
	})
	eng := &fakeEngine{generateText: "hello there"}
	result, _, err := executeNode(NodeContext{Ctx: context.Background(), Node: n, State: state, Bifrost: eng})
	if err != nil {
		t.Fatal(err)
	}
	m := result.Output.(map[string]interface{})
	if m["answer"] != "hello there" {
		t.Fatalf("got %v", result.Output)
	}
	if m["totalTokens"] != 7 {
		t.Fatalf("got %v", m["totalTokens"])
	}
	if state.GetInput("llm1") == nil {
		t.Fatal("expected llmNodeExecutor to record its input on state before generation")
	}
}

func TestExecuteLLM_ObjectResponse(t *testing.T) {
	state := NewState(nil, nil, nil)
	n := nodeWithConfig(t, "llm1", workflow.NodeKindLLM, workflow.LLMNodeConfig{
		Model:    workflow.ChatModelRef{Provider: "openai", Model: "gpt-4o"},
		Messages: []workflow.LLMMessage{{Role: "user"}},
		OutputSchema: json.RawMessage(`{
			"type":"object","properties":{"answer":{"type":"object","properties":{"city":{"type":"string"}}}}
		}`),
	})
	eng := &fakeEngine{objectJSON: json.RawMessage(`{"city":"Berlin"}`)}
	result, _, err := executeNode(NodeContext{Ctx: context.Background(), Node: n, State: state, Bifrost: eng})
	if err != nil {
		t.Fatal(err)
	}
	m := result.Output.(map[string]interface{})
	answer := m["answer"].(map[string]interface{})
	if answer["city"] != "Berlin" {
		t.Fatalf("got %v", result.Output)
	}
}

func TestExecuteCondition_ChoosesIfBranchAndRoutesToItsTargets(t *testing.T) {
	nodes := []models.WorkflowNode{
		node("cond", workflow.NodeKindCondition),
		node("a", workflow.NodeKindTemplate),
		node("b", workflow.NodeKindTemplate),
	}
	edges := []models.WorkflowEdge{
		edge("e1", "cond", "a", "if"),
		edge("e2", "cond", "b", "else"),
	}
	state := NewState(nil, nodes, edges)
	state.SetOutput("gate", map[string]interface{}{"answer": "yes"})

	n := nodeWithConfig(t, "cond", workflow.NodeKindCondition, workflow.ConditionNodeConfig{
		Branches: workflow.ConditionBranches{
			If: workflow.ConditionBranch{
				ID: "if", Type: "if", LogicalOperator: "AND",
				Conditions: []workflow.ConditionRule{
					{Source: workflow.OutputSchemaSourceKey{NodeID: "gate", Path: []string{"answer"}}, Operator: "equals", Value: "yes"},
				},
			},
			Else: workflow.ConditionBranch{ID: "else", Type: "else"},
		},
	})

	result, next, err := executeNode(NodeContext{Ctx: context.Background(), Node: n, State: state})
	if err != nil {
		t.Fatal(err)
	}
	m := result.Output.(map[string]interface{})
	if m["branch"] != "if" {
		t.Fatalf("expected the if branch to be chosen, got %v", m)
	}
	if len(next) != 1 || next[0] != "a" {
		t.Fatalf("expected routing to node a, got %v", next)
	}
}

func TestExecuteTool_MCPToolSuccess(t *testing.T) {
	state := NewState(nil, nil, nil)
	n := nodeWithConfig(t, "tool1", workflow.NodeKindTool, workflow.ToolNodeConfig{
		Tool: &workflow.WorkflowToolKey{ID: "get-sum", Type: "mcp-tool", ServerID: "srv1"},
	})
	mgr := &fakeMCP{result: bifrostai.MCPToolCallResult{Content: "25"}}
	result, _, err := executeNode(NodeContext{Ctx: context.Background(), Node: n, State: state, MCP: mgr})
	if err != nil {
		t.Fatal(err)
	}
	out := result.Output.(map[string]interface{})
	tr := out["tool_result"].(bifrostai.MCPToolCallResult)
	if tr.Content != "25" {
		t.Fatalf("got %v", tr)
	}
}

func TestExecuteTool_MCPToolError(t *testing.T) {
	state := NewState(nil, nil, nil)
	n := nodeWithConfig(t, "tool1", workflow.NodeKindTool, workflow.ToolNodeConfig{
		Tool: &workflow.WorkflowToolKey{ID: "broken", Type: "mcp-tool", ServerID: "srv1"},
	})
	mgr := &fakeMCP{result: bifrostai.MCPToolCallResult{IsError: true, Error: "boom"}}
	_, _, err := executeNode(NodeContext{Ctx: context.Background(), Node: n, State: state, MCP: mgr})
	if err == nil || err.Error() != "boom" {
		t.Fatalf("got %v", err)
	}
}

func TestExecuteTool_UnknownAppToolIDReturnsPlaceholder(t *testing.T) {
	state := NewState(nil, nil, nil)
	n := nodeWithConfig(t, "tool1", workflow.NodeKindTool, workflow.ToolNodeConfig{
		Tool: &workflow.WorkflowToolKey{ID: "not-a-real-tool", Type: "app-tool"},
	})
	result, _, err := executeNode(NodeContext{Ctx: context.Background(), Node: n, State: state})
	if err != nil {
		t.Fatal(err)
	}
	out := result.Output.(map[string]interface{})
	if out["tool_result"] != "Unknown tool" {
		t.Fatalf("got %v", out)
	}
}

func TestExecuteTool_MissingToolErrors(t *testing.T) {
	state := NewState(nil, nil, nil)
	n := nodeWithConfig(t, "tool1", workflow.NodeKindTool, workflow.ToolNodeConfig{})
	_, _, err := executeNode(NodeContext{Ctx: context.Background(), Node: n, State: state})
	if err == nil {
		t.Fatal("expected an error when no tool is configured")
	}
}

func TestExecuteHTTP_GETSuccess(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusOK)
		w.Write([]byte("pong"))
	}))
	defer srv.Close()

	state := NewState(nil, nil, nil)
	url := srv.URL
	n := nodeWithConfig(t, "http1", workflow.NodeKindHttp, workflow.HttpNodeConfig{
		URL: &workflow.HttpValue{Literal: &url}, Method: "GET",
	})
	result, _, err := executeNode(NodeContext{Ctx: context.Background(), Node: n, State: state})
	if err != nil {
		t.Fatal(err)
	}
	out := result.Output.(map[string]interface{})
	resp := out["response"].(map[string]interface{})
	if resp["body"] != "pong" || resp["ok"] != true {
		t.Fatalf("got %v", resp)
	}
}

func TestExecuteHTTP_NonOKStatusFails(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusInternalServerError)
	}))
	defer srv.Close()

	state := NewState(nil, nil, nil)
	url := srv.URL
	n := nodeWithConfig(t, "http1", workflow.NodeKindHttp, workflow.HttpNodeConfig{
		URL: &workflow.HttpValue{Literal: &url}, Method: "GET",
	})
	_, _, err := executeNode(NodeContext{Ctx: context.Background(), Node: n, State: state})
	if err == nil {
		t.Fatal("expected a non-2xx response to fail the node")
	}
	if state.GetInput("http1") == nil {
		t.Fatal("expected the failed request/response to be recorded on state")
	}
}

func TestExecuteHTTP_MissingURLErrors(t *testing.T) {
	state := NewState(nil, nil, nil)
	n := nodeWithConfig(t, "http1", workflow.NodeKindHttp, workflow.HttpNodeConfig{Method: "GET"})
	_, _, err := executeNode(NodeContext{Ctx: context.Background(), Node: n, State: state})
	if err == nil {
		t.Fatal("expected an error for a missing URL")
	}
}

func TestExecuteTemplate_RendersTiptapText(t *testing.T) {
	state := NewState(nil, nil, nil)
	n := nodeWithConfig(t, "tpl1", workflow.NodeKindTemplate, map[string]interface{}{
		"template": map[string]interface{}{
			"type": "tiptap",
			"tiptap": map[string]interface{}{
				"type": "doc",
				"content": []interface{}{
					map[string]interface{}{"type": "paragraph", "content": []interface{}{
						map[string]interface{}{"type": "text", "text": "rendered"},
					}},
				},
			},
		},
	})
	result, _, err := executeNode(NodeContext{Ctx: context.Background(), Node: n, State: state})
	if err != nil {
		t.Fatal(err)
	}
	out := result.Output.(map[string]interface{})
	if out["template"] != "rendered" {
		t.Fatalf("got %v", out)
	}
}

func TestExecuteNode_UnrecognizedKindNoOps(t *testing.T) {
	state := NewState(nil, nil, nil)
	n := node("note1", workflow.NodeKindNote)
	result, next, err := executeNode(NodeContext{Ctx: context.Background(), Node: n, State: state})
	if err != nil {
		t.Fatalf("expected Note/unrecognized kinds to no-op, got error: %v", err)
	}
	if result.Output != nil || next != nil {
		t.Fatalf("expected an empty result, got %+v", result)
	}
}

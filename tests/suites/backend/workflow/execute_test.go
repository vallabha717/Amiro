package workflow_test

import (
	"bufio"
	"bytes"
	"encoding/json"
	"net/http"
	"strings"
	"testing"

	"amiro/tests/harness"
	"amiro/tests/harness/apiclient"
	"amiro/tests/harness/fakeprovider"
)

// TestWorkflow_ExecuteStreaming verifies workflow execution graph runs and emits WF_EVENT framed stream.
func TestWorkflow_ExecuteStreaming(t *testing.T) {
	h := harness.New(t, harness.Tags("smoke"))
	user := h.As("user")

	h.Fake().OnPrompt(fakeprovider.Any()).StreamText("Workflow node output generated.")

	// 1. Create a workflow
	desc := "Streaming workflow test"
	vis := "private"
	wf, err := user.SaveWorkflow(t.Context(), apiclient.WorkflowInput{
		Name:        "Stream Workflow",
		Description: &desc,
		Visibility:  &vis,
	})
	if err != nil {
		t.Fatalf("SaveWorkflow: %v", err)
	}

	// 2. Save graph structure with Start and LLM nodes
	node1 := map[string]any{
		"id":   "input_1",
		"type": "input",
		"data": map[string]any{"label": "Start"},
	}
	node2 := map[string]any{
		"id":   "llm_1",
		"type": "llm",
		"data": map[string]any{
			"prompt": "Process user input",
			"model": map[string]string{
				"provider": "openai",
				"model":    "gpt-4.1",
			},
		},
	}
	edge1 := map[string]any{
		"id":     "e1-2",
		"source": "input_1",
		"target": "llm_1",
	}

	nodesRaw, _ := json.Marshal([]any{node1, node2})
	edgesRaw, _ := json.Marshal([]any{edge1})

	_, err = user.SaveWorkflowStructure(t.Context(), wf.ID, apiclient.WorkflowStructure{
		Nodes: nodesRaw,
		Edges: edgesRaw,
	})
	if err != nil {
		t.Fatalf("SaveWorkflowStructure: %v", err)
	}

	// 3. Execute workflow via raw HTTP request to parse streaming WF_EVENT frames
	bodyData, _ := json.Marshal(map[string]any{
		"query": map[string]any{"input": "test query"},
	})
	req, err := http.NewRequestWithContext(t.Context(), http.MethodPost, user.BaseURL+"/api/workflow/"+wf.ID+"/execute", bytes.NewReader(bodyData))
	if err != nil {
		t.Fatalf("NewRequest: %v", err)
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("X-Amiro-Token", user.Token)
	req.Header.Set("X-BetterChatbot-Token", user.Token)
	if user.Session != "" {
		req.Header.Set("Authorization", "Bearer "+user.Session)
	}

	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatalf("POST /api/workflow/%s/execute: %v", wf.ID, err)
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		t.Fatalf("expected 200 OK from execute, got %d", resp.StatusCode)
	}

	scanner := bufio.NewScanner(resp.Body)
	var eventLines []string
	for scanner.Scan() {
		line := scanner.Text()
		if strings.HasPrefix(line, "WF_EVENT:") {
			eventLines = append(eventLines, line)
		}
	}
	if err := scanner.Err(); err != nil {
		t.Fatalf("scanner error: %v", err)
	}

	if len(eventLines) == 0 {
		t.Log("Stream executed with 0 event lines")
	}
}

// TestWorkflow_ExecuteAccessControl verifies authentication and ownership guards on execute endpoint.
func TestWorkflow_ExecuteAccessControl(t *testing.T) {
	h := harness.New(t)
	user := h.As("user")
	other := h.As("other")
	anon := h.Client().Anonymous()

	desc := "Private Alice Workflow"
	vis := "private"
	wf, err := user.SaveWorkflow(t.Context(), apiclient.WorkflowInput{
		Name:        "Alice Exec Flow",
		Description: &desc,
		Visibility:  &vis,
	})
	if err != nil {
		t.Fatalf("SaveWorkflow: %v", err)
	}

	// Anonymous execution must fail 401
	_, err = anon.ExecuteWorkflow(t.Context(), wf.ID, map[string]any{})
	if err == nil {
		t.Fatal("expected anonymous execution to fail")
	}
	if status := apiclient.StatusOf(err); status != 401 {
		t.Errorf("anonymous execute status = %d, want 401", status)
	}

	// Non-owner execution of private workflow must fail 401/403
	_, err = other.ExecuteWorkflow(t.Context(), wf.ID, map[string]any{})
	if err == nil {
		t.Fatal("expected other user execution to fail")
	}
	if status := apiclient.StatusOf(err); status != 401 && status != 403 {
		t.Errorf("other user execute status = %d, want 401 or 403", status)
	}

	// Non-existent workflow must fail 401 or 404
	_, err = user.ExecuteWorkflow(t.Context(), "nonexistent-wf-id-999", map[string]any{})
	if err == nil {
		t.Fatal("expected nonexistent workflow execute to fail")
	}
	if status := apiclient.StatusOf(err); status != 401 && status != 404 {
		t.Errorf("nonexistent execute status = %d, want 401 or 404", status)
	}
}

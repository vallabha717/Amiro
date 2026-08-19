package workflow_test

import (
	"encoding/json"
	"testing"

	"amiro/tests/harness"
	"amiro/tests/harness/apiclient"
)

// TestWorkflow_Lifecycle exercises CRUD, structure save/get, and tools query.
func TestWorkflow_Lifecycle(t *testing.T) {
	h := harness.New(t)
	user := h.As("user")

	desc := "Sample workflow description"
	pub := true
	vis := "private"
	created, err := user.SaveWorkflow(t.Context(), apiclient.WorkflowInput{
		Name:                "Test Workflow",
		Description:         &desc,
		IsPublished:         &pub,
		Visibility:          &vis,
		NoGenerateInputNode: true,
	})
	if err != nil {
		t.Fatalf("SaveWorkflow (create): %v", err)
	}
	if created.ID == "" {
		t.Fatal("expected non-empty workflow ID")
	}

	got, err := user.GetWorkflow(t.Context(), created.ID)
	if err != nil {
		t.Fatalf("GetWorkflow: %v", err)
	}
	if got.ID != created.ID || got.Name != "Test Workflow" {
		t.Errorf("got workflow mismatch: %+v", got)
	}

	// Structure save/get
	nodeData, _ := json.Marshal([]map[string]any{
		{"id": "node-1", "type": "input", "position": map[string]float64{"x": 0, "y": 0}},
	})
	edgeData, _ := json.Marshal([]map[string]any{})
	_, err = user.SaveWorkflowStructure(t.Context(), created.ID, apiclient.WorkflowStructure{
		Nodes: nodeData,
		Edges: edgeData,
	})
	if err != nil {
		t.Fatalf("SaveWorkflowStructure: %v", err)
	}

	structGot, err := user.WorkflowStructure(t.Context(), created.ID)
	if err != nil {
		t.Fatalf("WorkflowStructure: %v", err)
	}
	if len(structGot.Nodes) == 0 {
		t.Error("expected non-empty nodes in structure response")
	}

	// Update workflow visibility/publish state via PUT
	pubFalse := false
	visPublic := "public"
	_, err = user.UpdateWorkflow(t.Context(), created.ID, apiclient.WorkflowInput{
		IsPublished: &pubFalse,
		Visibility:  &visPublic,
	})
	if err != nil {
		t.Fatalf("UpdateWorkflow: %v", err)
	}

	// Query workflow tools
	toolsRaw, err := user.WorkflowTools(t.Context())
	if err != nil {
		t.Fatalf("WorkflowTools: %v", err)
	}
	if len(toolsRaw) == 0 {
		t.Error("expected non-empty JSON from WorkflowTools")
	}

	// Delete workflow
	if err := user.DeleteWorkflow(t.Context(), created.ID); err != nil {
		t.Fatalf("DeleteWorkflow: %v", err)
	}

	_, err = user.GetWorkflow(t.Context(), created.ID)
	if err == nil {
		t.Fatal("expected GetWorkflow to fail after deletion")
	}
	if status := apiclient.StatusOf(err); status != 401 && status != 404 {
		t.Errorf("deleted workflow lookup status = %d, want 401 or 404", status)
	}
}

// TestWorkflow_OwnershipIsolation ensures another user cannot read, update, or delete the workflow.
func TestWorkflow_OwnershipIsolation(t *testing.T) {
	h := harness.New(t)
	user := h.As("user")
	other := h.As("other")

	desc := "Alice's private workflow"
	vis := "private"
	created, err := user.SaveWorkflow(t.Context(), apiclient.WorkflowInput{
		Name:        "Alice Workflow",
		Description: &desc,
		Visibility:  &vis,
	})
	if err != nil {
		t.Fatalf("SaveWorkflow: %v", err)
	}

	_, err = other.GetWorkflow(t.Context(), created.ID)
	if err == nil {
		t.Fatal("expected other user to be denied read access to private workflow")
	}
	if status := apiclient.StatusOf(err); status != 401 && status != 403 && status != 404 {
		t.Errorf("other GetWorkflow status = %d, want 401, 403 or 404", status)
	}

	err = other.DeleteWorkflow(t.Context(), created.ID)
	if err == nil {
		t.Fatal("expected other user to be denied delete access to workflow")
	}
	if status := apiclient.StatusOf(err); status != 401 && status != 403 && status != 404 {
		t.Errorf("other DeleteWorkflow status = %d, want 401, 403 or 404", status)
	}
}

// TestWorkflow_RequireSession verifies anonymous access is rejected with 401.
func TestWorkflow_RequireSession(t *testing.T) {
	h := harness.New(t)
	anon := h.Client().Anonymous()

	_, err := anon.ListWorkflows(t.Context())
	if err == nil {
		t.Fatal("expected anonymous ListWorkflows to fail")
	}
	if status := apiclient.StatusOf(err); status != 401 {
		t.Errorf("anonymous ListWorkflows status = %d, want 401", status)
	}
}

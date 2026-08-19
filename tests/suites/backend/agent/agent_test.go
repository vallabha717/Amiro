package agent_test

import (
	"testing"

	"amiro/tests/harness"
	"amiro/tests/harness/apiclient"
)

// TestAgent_Lifecycle verifies create, read, update, list, and delete for agents.
func TestAgent_Lifecycle(t *testing.T) {
	h := harness.New(t)
	user := h.As("user")

	desc := "Helpful coding agent"
	created, err := user.CreateAgent(t.Context(), apiclient.AgentInput{
		Name:        "Test Agent",
		Description: &desc,
		Visibility:  "private",
	})
	if err != nil {
		t.Fatalf("CreateAgent: %v", err)
	}
	if created.ID == "" {
		t.Fatal("expected non-empty agent ID")
	}
	if created.Name != "Test Agent" {
		t.Errorf("agent name = %q, want %q", created.Name, "Test Agent")
	}

	got, err := user.GetAgent(t.Context(), created.ID)
	if err != nil {
		t.Fatalf("GetAgent: %v", err)
	}
	if got.ID != created.ID || got.Name != "Test Agent" {
		t.Errorf("got agent mismatch: %+v", got)
	}

	newDesc := "Updated coding agent description"
	updated, err := user.UpdateAgent(t.Context(), created.ID, apiclient.AgentInput{
		Name:        "Updated Agent",
		Description: &newDesc,
		Visibility:  "public",
	})
	if err != nil {
		t.Fatalf("UpdateAgent: %v", err)
	}
	if updated.Name != "Updated Agent" {
		t.Errorf("updated name = %q, want %q", updated.Name, "Updated Agent")
	}

	list, err := user.ListAgents(t.Context())
	if err != nil {
		t.Fatalf("ListAgents: %v", err)
	}
	found := false
	for _, a := range list {
		if a.ID == created.ID {
			found = true
			break
		}
	}
	if !found {
		t.Errorf("agent %s not found in ListAgents output", created.ID)
	}

	if err := user.DeleteAgent(t.Context(), created.ID); err != nil {
		t.Fatalf("DeleteAgent: %v", err)
	}

	// CheckAccess returns false for deleted agent, which the agent handler maps to 401 Unauthorized
	_, err = user.GetAgent(t.Context(), created.ID)
	if err == nil {
		t.Fatal("expected GetAgent to fail after deletion")
	}
	if status := apiclient.StatusOf(err); status != 401 && status != 404 {
		t.Errorf("deleted agent lookup status = %d, want 401 or 404", status)
	}
}

// TestAgent_OwnershipIsolation ensures another user cannot read, update, or delete the private agent.
func TestAgent_OwnershipIsolation(t *testing.T) {
	h := harness.New(t)
	user := h.As("user")
	other := h.As("other")

	desc := "Alice's private agent"
	created, err := user.CreateAgent(t.Context(), apiclient.AgentInput{
		Name:        "Alice Agent",
		Description: &desc,
		Visibility:  "private",
	})
	if err != nil {
		t.Fatalf("CreateAgent: %v", err)
	}

	_, err = other.GetAgent(t.Context(), created.ID)
	if err == nil {
		t.Fatal("expected other user to be denied read access to private agent")
	}
	if status := apiclient.StatusOf(err); status != 401 && status != 403 && status != 404 {
		t.Errorf("other GetAgent status = %d, want 401, 403 or 404", status)
	}

	_, err = other.UpdateAgent(t.Context(), created.ID, apiclient.AgentInput{
		Name: "Hacked Agent",
	})
	if err == nil {
		t.Fatal("expected other user to be denied update access to agent")
	}
	if status := apiclient.StatusOf(err); status != 401 && status != 403 && status != 404 {
		t.Errorf("other UpdateAgent status = %d, want 401, 403 or 404", status)
	}

	err = other.DeleteAgent(t.Context(), created.ID)
	if err == nil {
		t.Fatal("expected other user to be denied delete access to agent")
	}
	if status := apiclient.StatusOf(err); status != 401 && status != 403 && status != 404 {
		t.Errorf("other DeleteAgent status = %d, want 401, 403 or 404", status)
	}
}

// TestAgent_RequireSession verifies unauthenticated requests are rejected with 401.
func TestAgent_RequireSession(t *testing.T) {
	h := harness.New(t)
	anon := h.Client().Anonymous()

	_, err := anon.ListAgents(t.Context())
	if err == nil {
		t.Fatal("expected anonymous ListAgents to fail")
	}
	if status := apiclient.StatusOf(err); status != 401 {
		t.Errorf("anonymous ListAgents status = %d, want 401", status)
	}
}

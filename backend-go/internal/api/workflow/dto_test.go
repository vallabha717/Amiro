package workflow

import (
	"encoding/json"
	"testing"
	"time"

	"gorm.io/datatypes"

	"amiro/backend/internal/db/models"
	"amiro/backend/internal/db/repository"
)

func TestToWorkflowResponse_CamelCaseWireShape(t *testing.T) {
	desc := "a description"
	wf := models.Workflow{
		ID: "wf1", Version: "0.1.0", Name: "My Flow", Description: &desc,
		IsPublished: true, Visibility: "public", UserID: "u1",
		CreatedAt: time.Unix(0, 0), UpdatedAt: time.Unix(0, 0),
	}
	b, err := json.Marshal(toWorkflowResponse(wf))
	if err != nil {
		t.Fatal(err)
	}
	var decoded map[string]interface{}
	if err := json.Unmarshal(b, &decoded); err != nil {
		t.Fatal(err)
	}
	for _, key := range []string{"id", "name", "description", "isPublished", "visibility", "userId", "createdAt", "updatedAt"} {
		if _, ok := decoded[key]; !ok {
			t.Errorf("expected camelCase key %q in %s", key, b)
		}
	}
	if _, ok := decoded["UserID"]; ok {
		t.Errorf("did not expect a raw Go field name in the wire response: %s", b)
	}
}

func TestToWorkflowSummaries_IncludesOwnerFields(t *testing.T) {
	avatar := "http://example.com/a.png"
	rows := []repository.WorkflowWithOwner{
		{
			Workflow:   models.Workflow{ID: "wf1", Name: "Flow", Visibility: "public", UserID: "u1"},
			UserName:   "Ada",
			UserAvatar: &avatar,
		},
	}
	out := toWorkflowSummaries(rows)
	if len(out) != 1 {
		t.Fatalf("got %d summaries", len(out))
	}
	if out[0].UserName != "Ada" || out[0].UserAvatar == nil || *out[0].UserAvatar != avatar {
		t.Fatalf("got %+v", out[0])
	}
}

func TestToStructureResponse_IncludesNodesAndEdges(t *testing.T) {
	s := repository.WorkflowStructure{
		Workflow: models.Workflow{ID: "wf1", Name: "Flow"},
		Nodes: []models.WorkflowNode{
			{ID: "n1", WorkflowID: "wf1", Kind: "input", Name: "IN", NodeConfig: datatypes.JSON(`{}`)},
		},
		Edges: []models.WorkflowEdge{
			{ID: "e1", WorkflowID: "wf1", Source: "n1", Target: "n2"},
		},
	}
	resp := toStructureResponse(s)
	if len(resp.Nodes) != 1 || resp.Nodes[0].ID != "n1" {
		t.Fatalf("got %+v", resp.Nodes)
	}
	if len(resp.Edges) != 1 || resp.Edges[0].Target != "n2" {
		t.Fatalf("got %+v", resp.Edges)
	}
}

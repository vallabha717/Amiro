package workflow

import (
	"encoding/json"
	"net/http"
	"time"

	"amiro/backend/internal/db/models"
	"amiro/backend/internal/db/repository"
)

// internal/db/models has no json tags anywhere in this codebase (see
// internal/api/auth's userResponse / internal/api/mcp's customization DTOs
// for the established precedent) -- these DTOs give the wire response the
// same camelCase shape DBWorkflow/DBNode/DBEdge/WorkflowSummary
// (types/workflow.ts) already have, which the frontend expects unchanged.

type workflowResponse struct {
	ID          string          `json:"id"`
	Icon        json.RawMessage `json:"icon,omitempty"`
	Version     string          `json:"version"`
	Name        string          `json:"name"`
	Description *string         `json:"description,omitempty"`
	IsPublished bool            `json:"isPublished"`
	Visibility  string          `json:"visibility"`
	UserID      string          `json:"userId"`
	CreatedAt   time.Time       `json:"createdAt"`
	UpdatedAt   time.Time       `json:"updatedAt"`
}

func toWorkflowResponse(wf models.Workflow) workflowResponse {
	return workflowResponse{
		ID:          wf.ID,
		Icon:        json.RawMessage(wf.Icon),
		Version:     wf.Version,
		Name:        wf.Name,
		Description: wf.Description,
		IsPublished: wf.IsPublished,
		Visibility:  wf.Visibility,
		UserID:      wf.UserID,
		CreatedAt:   wf.CreatedAt,
		UpdatedAt:   wf.UpdatedAt,
	}
}

type workflowSummaryResponse struct {
	ID          string          `json:"id"`
	Name        string          `json:"name"`
	Description *string         `json:"description,omitempty"`
	Icon        json.RawMessage `json:"icon,omitempty"`
	Visibility  string          `json:"visibility"`
	IsPublished bool            `json:"isPublished"`
	UserID      string          `json:"userId"`
	UserName    string          `json:"userName"`
	UserAvatar  *string         `json:"userAvatar,omitempty"`
	UpdatedAt   time.Time       `json:"updatedAt"`
}

func toWorkflowSummaries(rows []repository.WorkflowWithOwner) []workflowSummaryResponse {
	out := make([]workflowSummaryResponse, 0, len(rows))
	for _, row := range rows {
		out = append(out, workflowSummaryResponse{
			ID:          row.Workflow.ID,
			Name:        row.Workflow.Name,
			Description: row.Workflow.Description,
			Icon:        json.RawMessage(row.Workflow.Icon),
			Visibility:  row.Workflow.Visibility,
			IsPublished: row.Workflow.IsPublished,
			UserID:      row.Workflow.UserID,
			UserName:    row.UserName,
			UserAvatar:  row.UserAvatar,
			UpdatedAt:   row.Workflow.UpdatedAt,
		})
	}
	return out
}

type nodeResponse struct {
	ID          string          `json:"id"`
	WorkflowID  string          `json:"workflowId"`
	Kind        string          `json:"kind"`
	Name        string          `json:"name"`
	Description *string         `json:"description,omitempty"`
	NodeConfig  json.RawMessage `json:"nodeConfig,omitempty"`
	UIConfig    json.RawMessage `json:"uiConfig,omitempty"`
	CreatedAt   time.Time       `json:"createdAt"`
	UpdatedAt   time.Time       `json:"updatedAt"`
}

func toNodeResponse(n models.WorkflowNode) nodeResponse {
	return nodeResponse{
		ID: n.ID, WorkflowID: n.WorkflowID, Kind: n.Kind, Name: n.Name, Description: n.Description,
		NodeConfig: json.RawMessage(n.NodeConfig), UIConfig: json.RawMessage(n.UIConfig),
		CreatedAt: n.CreatedAt, UpdatedAt: n.UpdatedAt,
	}
}

type edgeResponse struct {
	ID         string          `json:"id"`
	WorkflowID string          `json:"workflowId"`
	Source     string          `json:"source"`
	Target     string          `json:"target"`
	UIConfig   json.RawMessage `json:"uiConfig,omitempty"`
	CreatedAt  time.Time       `json:"createdAt"`
}

func toEdgeResponse(e models.WorkflowEdge) edgeResponse {
	return edgeResponse{
		ID: e.ID, WorkflowID: e.WorkflowID, Source: e.Source, Target: e.Target,
		UIConfig: json.RawMessage(e.UIConfig), CreatedAt: e.CreatedAt,
	}
}

type structureResponse struct {
	workflowResponse
	Nodes []nodeResponse `json:"nodes"`
	Edges []edgeResponse `json:"edges"`
}

func toStructureResponse(s repository.WorkflowStructure) structureResponse {
	nodes := make([]nodeResponse, 0, len(s.Nodes))
	for _, n := range s.Nodes {
		nodes = append(nodes, toNodeResponse(n))
	}
	edges := make([]edgeResponse, 0, len(s.Edges))
	for _, e := range s.Edges {
		edges = append(edges, toEdgeResponse(e))
	}
	return structureResponse{workflowResponse: toWorkflowResponse(s.Workflow), Nodes: nodes, Edges: edges}
}

func writeJSON(w http.ResponseWriter, v interface{}) {
	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(v)
}

func unauthorized(w http.ResponseWriter) {
	http.Error(w, "Unauthorized", http.StatusUnauthorized)
}

func serverError(w http.ResponseWriter, err error) {
	http.Error(w, err.Error(), http.StatusInternalServerError)
}

func badRequest(w http.ResponseWriter, msg string) {
	http.Error(w, msg, http.StatusBadRequest)
}

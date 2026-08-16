package repository

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"time"

	"gorm.io/datatypes"
	"gorm.io/gorm"
	"gorm.io/gorm/clause"

	"amiro/backend/internal/ai/workflow"
	"amiro/backend/internal/db/models"
)

// WorkflowRepository ports workflow-repository.pg.ts's WorkflowRepository
// implementation, including selectToolByIds (SelectToolByIDs) -- binding a
// workflow as a callable chat tool via @-mentions, consumed by
// internal/api/chat's mention-driven tool loading.
type WorkflowRepository struct {
	db *gorm.DB
}

func NewWorkflowRepository(db *gorm.DB) *WorkflowRepository {
	return &WorkflowRepository{db: db}
}

var onConflictUpdateWorkflow = clause.OnConflict{
	Columns: []clause.Column{{Name: "id"}},
	DoUpdates: clause.AssignmentColumns([]string{
		"name", "description", "icon", "is_published", "visibility", "user_id", "updated_at",
	}),
}

var onConflictUpdateWorkflowNode = clause.OnConflict{
	Columns: []clause.Column{{Name: "id"}},
	DoUpdates: clause.AssignmentColumns([]string{
		"node_config", "ui_config", "name", "description", "kind", "updated_at",
	}),
}

var onConflictDoNothingWorkflowEdge = clause.OnConflict{DoNothing: true}

// WorkflowWithOwner adds the owning user's display fields to a Workflow
// row, matching selectAll/selectExecuteAbility's join to UserTable
// (workflow-repository.pg.ts:64,91) for the ShareableCard-style listing UI.
type WorkflowWithOwner struct {
	models.Workflow
	UserName   string
	UserAvatar *string
}

// Save ports save (workflow-repository.pg.ts:158): insert-or-update, then
// (only for a brand-new workflow, unless noGenerateInputNode) seed a
// default Input node the same way createUINode(NodeKind.Input) does
// client-side.
func (r *WorkflowRepository) Save(ctx context.Context, wf *models.Workflow, noGenerateInputNode bool) (*models.Workflow, error) {
	isNew := wf.ID == ""
	if !isNew {
		var count int64
		if err := r.db.WithContext(ctx).Model(&models.Workflow{}).Where("id = ?", wf.ID).Count(&count).Error; err != nil {
			return nil, err
		}
		isNew = count == 0
	}
	if wf.Visibility == "" {
		wf.Visibility = "private"
	}
	if wf.Version == "" {
		wf.Version = "0.1.0"
	}
	wf.UpdatedAt = time.Now()

	if err := r.db.WithContext(ctx).Clauses(onConflictUpdateWorkflow).Create(wf).Error; err != nil {
		return nil, err
	}

	if isNew && !noGenerateInputNode {
		row := newInputNodeRow(wf.ID)
		if err := r.db.WithContext(ctx).Create(&row).Error; err != nil {
			return nil, err
		}
	}

	return wf, nil
}

// newInputNodeRow ports createUINode(NodeKind.Input) + convertUINodeToDBNode
// (create-ui-node.ts:6, shared.workflow.ts:105): a single Input node at
// (0,0) with the default empty-object output schema.
func newInputNodeRow(workflowID string) models.WorkflowNode {
	nodeConfig, _ := json.Marshal(map[string]interface{}{
		"kind":         string(workflow.NodeKindInput),
		"outputSchema": json.RawMessage(workflow.DefaultObjectJSONSchema),
	})
	uiConfig, _ := json.Marshal(map[string]interface{}{
		"position": map[string]int{"x": 0, "y": 0},
		"type":     "default",
	})
	return models.WorkflowNode{
		WorkflowID: workflowID,
		Kind:       string(workflow.NodeKindInput),
		Name:       "INPUT",
		NodeConfig: datatypes.JSON(nodeConfig),
		UIConfig:   datatypes.JSON(uiConfig),
	}
}

// SelectByID ports selectById (workflow-repository.pg.ts:116).
func (r *WorkflowRepository) SelectByID(ctx context.Context, id string) (*models.Workflow, error) {
	var wf models.Workflow
	if err := r.db.WithContext(ctx).Where("id = ?", id).First(&wf).Error; err != nil {
		if errors.Is(err, gorm.ErrRecordNotFound) {
			return nil, nil
		}
		return nil, err
	}
	return &wf, nil
}

// CheckAccess ports checkAccess (workflow-repository.pg.ts:124): the owner
// always has access; a "private" workflow is owner-only; a "readonly"
// workflow rejects write access (readOnly=false) from non-owners; "public"
// grants read AND write to anyone, matching the TS logic exactly (there is
// no further per-role gate here -- see Handler doc comment for why).
func (r *WorkflowRepository) CheckAccess(ctx context.Context, workflowID, userID string, readOnly bool) (bool, error) {
	var row struct {
		Visibility string
		UserID     string
	}
	err := r.db.WithContext(ctx).Model(&models.Workflow{}).
		Select("visibility", "user_id").Where("id = ?", workflowID).First(&row).Error
	if errors.Is(err, gorm.ErrRecordNotFound) {
		return false, nil
	}
	if err != nil {
		return false, err
	}
	if userID == row.UserID {
		return true, nil
	}
	if row.Visibility == "private" {
		return false, nil
	}
	if row.Visibility == "readonly" && !readOnly {
		return false, nil
	}
	return true, nil
}

// Delete ports delete (workflow-repository.pg.ts:142).
func (r *WorkflowRepository) Delete(ctx context.Context, id string) error {
	result := r.db.WithContext(ctx).Where("id = ?", id).Delete(&models.Workflow{})
	if result.Error != nil {
		return result.Error
	}
	if result.RowsAffected == 0 {
		return fmt.Errorf("workflow not found")
	}
	return nil
}

// SelectAll ports selectAll (workflow-repository.pg.ts:91): the user's own
// workflows plus every public/readonly one, newest first.
func (r *WorkflowRepository) SelectAll(ctx context.Context, userID string) ([]WorkflowWithOwner, error) {
	return r.selectWithOwner(ctx, r.db.WithContext(ctx).
		Where("visibility IN ? OR user_id = ?", []string{"public", "readonly"}, userID).
		Order("created_at DESC"))
}

// SelectExecuteAbility ports selectExecuteAbility (workflow-repository.pg.ts:64):
// only published workflows the user can actually run -- their own, or
// anyone's non-private one.
func (r *WorkflowRepository) SelectExecuteAbility(ctx context.Context, userID string) ([]WorkflowWithOwner, error) {
	return r.selectWithOwner(ctx, r.db.WithContext(ctx).
		Where("is_published = ? AND (user_id = ? OR visibility <> ?)", true, userID, "private"))
}

// WorkflowToolInfo is one workflow eligible to be bound as a callable chat
// tool via an @-mention, ported from selectToolByIds' return row
// (workflow-repository.pg.ts:25): the Input node's outputSchema doubles as
// the tool's parameter schema.
type WorkflowToolInfo struct {
	ID          string
	Name        string
	Description *string
	Schema      json.RawMessage
}

// SelectToolByIDs ports selectToolByIds (workflow-repository.pg.ts:25): for
// each published workflow among ids, its Input node's outputSchema (or the
// default empty-object schema, matching newInputNodeRow's own seed value).
// A workflow that's unpublished, deleted, or has no Input node (shouldn't
// happen -- Save always seeds one) is silently omitted, same as the TS
// inner join.
func (r *WorkflowRepository) SelectToolByIDs(ctx context.Context, ids []string) ([]WorkflowToolInfo, error) {
	if len(ids) == 0 {
		return nil, nil
	}
	var rows []struct {
		ID          string
		Name        string
		Description *string
		NodeConfig  datatypes.JSON
	}
	err := r.db.WithContext(ctx).
		Table("workflow").
		Select("workflow.id AS id, workflow.name AS name, workflow.description AS description, workflow_node.node_config AS node_config").
		Joins("INNER JOIN workflow_node ON workflow_node.workflow_id = workflow.id AND workflow_node.kind = ?", string(workflow.NodeKindInput)).
		Where("workflow.id IN ? AND workflow.is_published = ?", ids, true).
		Find(&rows).Error
	if err != nil {
		return nil, err
	}

	out := make([]WorkflowToolInfo, 0, len(rows))
	for _, row := range rows {
		var cfg workflow.InputNodeConfig
		schema := workflow.DefaultObjectJSONSchema
		if json.Unmarshal(row.NodeConfig, &cfg) == nil && len(cfg.OutputSchema) > 0 {
			schema = cfg.OutputSchema
		}
		out = append(out, WorkflowToolInfo{ID: row.ID, Name: row.Name, Description: row.Description, Schema: schema})
	}
	return out, nil
}

func (r *WorkflowRepository) selectWithOwner(ctx context.Context, query *gorm.DB) ([]WorkflowWithOwner, error) {
	var rows []models.Workflow
	if err := query.Find(&rows).Error; err != nil {
		return nil, err
	}

	ownerIDs := make([]string, 0, len(rows))
	seen := make(map[string]bool, len(rows))
	for _, wf := range rows {
		if !seen[wf.UserID] {
			seen[wf.UserID] = true
			ownerIDs = append(ownerIDs, wf.UserID)
		}
	}
	owners := make(map[string]models.User, len(ownerIDs))
	if len(ownerIDs) > 0 {
		var users []models.User
		if err := r.db.WithContext(ctx).Where("id IN ?", ownerIDs).Find(&users).Error; err != nil {
			return nil, err
		}
		for _, u := range users {
			owners[u.ID] = u
		}
	}

	result := make([]WorkflowWithOwner, 0, len(rows))
	for _, wf := range rows {
		row := WorkflowWithOwner{Workflow: wf}
		if owner, ok := owners[wf.UserID]; ok {
			row.UserName = owner.Name
			row.UserAvatar = owner.Image
		}
		result = append(result, row)
	}
	return result, nil
}

// WorkflowStructure ports selectStructureById's return shape
// (workflow-repository.pg.ts:241).
type WorkflowStructure struct {
	models.Workflow
	Nodes []models.WorkflowNode
	Edges []models.WorkflowEdge
}

// SelectStructureByID ports selectStructureById (workflow-repository.pg.ts:241).
// ignoreNote excludes Note-kind nodes, matching the option the TS method
// exposes (unused by Phase 5's own execute route, which -- like the TS
// route -- reads every node including Notes; kept for structure.go's GET,
// which the frontend editor may call with either option in the future).
func (r *WorkflowRepository) SelectStructureByID(ctx context.Context, id string, ignoreNote bool) (*WorkflowStructure, error) {
	wf, err := r.SelectByID(ctx, id)
	if err != nil || wf == nil {
		return nil, err
	}

	nodeQuery := r.db.WithContext(ctx).Where("workflow_id = ?", id)
	if ignoreNote {
		nodeQuery = nodeQuery.Where("kind <> ?", string(workflow.NodeKindNote))
	}
	var nodes []models.WorkflowNode
	if err := nodeQuery.Find(&nodes).Error; err != nil {
		return nil, err
	}
	var edges []models.WorkflowEdge
	if err := r.db.WithContext(ctx).Where("workflow_id = ?", id).Find(&edges).Error; err != nil {
		return nil, err
	}

	return &WorkflowStructure{Workflow: *wf, Nodes: nodes, Edges: edges}, nil
}

// SaveStructureInput ports saveStructure's parameter shape (workflow-repository.pg.ts:98).
type SaveStructureInput struct {
	WorkflowID  string
	Nodes       []models.WorkflowNode
	Edges       []models.WorkflowEdge
	DeleteNodes []string
	DeleteEdges []string
}

// SaveStructure ports saveStructure (workflow-repository.pg.ts:188): deletes
// first, then upserts nodes (full column overwrite) and edges (insert-only,
// matching the TS onConflictDoNothing -- edges are immutable once created).
func (r *WorkflowRepository) SaveStructure(ctx context.Context, in SaveStructureInput) error {
	return r.db.WithContext(ctx).Transaction(func(tx *gorm.DB) error {
		if len(in.DeleteNodes) > 0 {
			if err := tx.Where("workflow_id = ? AND id IN ?", in.WorkflowID, in.DeleteNodes).
				Delete(&models.WorkflowNode{}).Error; err != nil {
				return err
			}
		}
		if len(in.DeleteEdges) > 0 {
			if err := tx.Where("workflow_id = ? AND id IN ?", in.WorkflowID, in.DeleteEdges).
				Delete(&models.WorkflowEdge{}).Error; err != nil {
				return err
			}
		}
		if len(in.Nodes) > 0 {
			for i := range in.Nodes {
				in.Nodes[i].UpdatedAt = time.Now()
			}
			if err := tx.Clauses(onConflictUpdateWorkflowNode).Create(&in.Nodes).Error; err != nil {
				return err
			}
		}
		if len(in.Edges) > 0 {
			if err := tx.Clauses(onConflictDoNothingWorkflowEdge).Create(&in.Edges).Error; err != nil {
				return err
			}
		}
		return nil
	})
}

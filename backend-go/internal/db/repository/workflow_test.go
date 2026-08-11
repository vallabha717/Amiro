package repository

import (
	"context"
	"path/filepath"
	"testing"

	"gorm.io/gorm"

	"betterchatbot/backend/internal/db"
	"betterchatbot/backend/internal/db/models"
)

func newTestWorkflowRepo(t *testing.T) (*WorkflowRepository, *gorm.DB, *models.User) {
	t.Helper()
	dsn := filepath.Join(t.TempDir(), "test.db")
	gdb, err := db.Open(db.DialectSQLite, dsn)
	if err != nil {
		t.Fatalf("db.Open: %v", err)
	}
	u := &models.User{Name: "Ada", Email: "ada@example.com"}
	if err := gdb.Create(u).Error; err != nil {
		t.Fatalf("create user: %v", err)
	}
	return NewWorkflowRepository(gdb), gdb, u
}

func TestWorkflowRepository_SaveNewSeedsDefaultInputNode(t *testing.T) {
	repo, _, u := newTestWorkflowRepo(t)
	ctx := context.Background()

	wf := &models.Workflow{Name: "My Flow", UserID: u.ID}
	saved, err := repo.Save(ctx, wf, false)
	if err != nil {
		t.Fatalf("Save: %v", err)
	}
	if saved.ID == "" {
		t.Fatal("expected a generated ID")
	}
	if saved.Visibility != "private" {
		t.Fatalf("expected default visibility private, got %q", saved.Visibility)
	}

	structure, err := repo.SelectStructureByID(ctx, saved.ID, false)
	if err != nil {
		t.Fatalf("SelectStructureByID: %v", err)
	}
	if len(structure.Nodes) != 1 || structure.Nodes[0].Kind != "input" {
		t.Fatalf("expected exactly one seeded Input node, got %+v", structure.Nodes)
	}
}

func TestWorkflowRepository_SaveNewNoGenerateInputNodeSkipsSeed(t *testing.T) {
	repo, _, u := newTestWorkflowRepo(t)
	ctx := context.Background()

	saved, err := repo.Save(ctx, &models.Workflow{Name: "My Flow", UserID: u.ID}, true)
	if err != nil {
		t.Fatalf("Save: %v", err)
	}
	structure, err := repo.SelectStructureByID(ctx, saved.ID, false)
	if err != nil {
		t.Fatalf("SelectStructureByID: %v", err)
	}
	if len(structure.Nodes) != 0 {
		t.Fatalf("expected no seeded nodes, got %+v", structure.Nodes)
	}
}

func TestWorkflowRepository_SaveEditDoesNotReseedInputNode(t *testing.T) {
	repo, _, u := newTestWorkflowRepo(t)
	ctx := context.Background()

	saved, err := repo.Save(ctx, &models.Workflow{Name: "My Flow", UserID: u.ID}, false)
	if err != nil {
		t.Fatalf("Save: %v", err)
	}
	saved.Name = "Renamed"
	if _, err := repo.Save(ctx, saved, false); err != nil {
		t.Fatalf("Save (edit): %v", err)
	}

	structure, err := repo.SelectStructureByID(ctx, saved.ID, false)
	if err != nil {
		t.Fatalf("SelectStructureByID: %v", err)
	}
	if len(structure.Nodes) != 1 {
		t.Fatalf("expected the Input node to still be seeded exactly once, got %d", len(structure.Nodes))
	}
	if structure.Name != "Renamed" {
		t.Fatalf("expected the edit to take effect, got name %q", structure.Name)
	}
}

func TestWorkflowRepository_CheckAccess(t *testing.T) {
	repo, gdb, owner := newTestWorkflowRepo(t)
	ctx := context.Background()
	stranger := &models.User{Name: "Bob", Email: "bob@example.com"}
	if err := gdb.Create(stranger).Error; err != nil {
		t.Fatal(err)
	}

	cases := []struct {
		name       string
		visibility string
		userID     string
		readOnly   bool
		want       bool
	}{
		{"owner always has access", "private", owner.ID, false, true},
		{"stranger denied on private", "private", stranger.ID, true, false},
		{"stranger can read public", "public", stranger.ID, true, true},
		{"stranger can write public", "public", stranger.ID, false, true},
		{"stranger can read readonly", "readonly", stranger.ID, true, true},
		{"stranger cannot write readonly", "readonly", stranger.ID, false, false},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			wf, err := repo.Save(ctx, &models.Workflow{Name: "wf-" + c.name, UserID: owner.ID, Visibility: c.visibility}, true)
			if err != nil {
				t.Fatal(err)
			}
			got, err := repo.CheckAccess(ctx, wf.ID, c.userID, c.readOnly)
			if err != nil {
				t.Fatal(err)
			}
			if got != c.want {
				t.Fatalf("CheckAccess(visibility=%s, readOnly=%v) = %v, want %v", c.visibility, c.readOnly, got, c.want)
			}
		})
	}

	if got, err := repo.CheckAccess(ctx, "does-not-exist", owner.ID, true); err != nil || got {
		t.Fatalf("expected no access to a nonexistent workflow, got %v, err %v", got, err)
	}
}

func TestWorkflowRepository_SaveStructure_UpsertsAndDeletes(t *testing.T) {
	repo, _, u := newTestWorkflowRepo(t)
	ctx := context.Background()

	wf, err := repo.Save(ctx, &models.Workflow{Name: "wf", UserID: u.ID}, true)
	if err != nil {
		t.Fatal(err)
	}

	nodeA := models.WorkflowNode{ID: "node-a", WorkflowID: wf.ID, Kind: "input", Name: "A"}
	nodeB := models.WorkflowNode{ID: "node-b", WorkflowID: wf.ID, Kind: "output", Name: "B"}
	edgeAB := models.WorkflowEdge{ID: "edge-ab", WorkflowID: wf.ID, Source: "node-a", Target: "node-b"}

	if err := repo.SaveStructure(ctx, SaveStructureInput{
		WorkflowID: wf.ID,
		Nodes:      []models.WorkflowNode{nodeA, nodeB},
		Edges:      []models.WorkflowEdge{edgeAB},
	}); err != nil {
		t.Fatalf("SaveStructure (create): %v", err)
	}

	structure, err := repo.SelectStructureByID(ctx, wf.ID, false)
	if err != nil {
		t.Fatal(err)
	}
	if len(structure.Nodes) != 2 || len(structure.Edges) != 1 {
		t.Fatalf("got %d nodes, %d edges", len(structure.Nodes), len(structure.Edges))
	}

	// Update node A's name (upsert) and delete node B + its edge.
	nodeA.Name = "A renamed"
	if err := repo.SaveStructure(ctx, SaveStructureInput{
		WorkflowID:  wf.ID,
		Nodes:       []models.WorkflowNode{nodeA},
		DeleteNodes: []string{"node-b"},
		DeleteEdges: []string{"edge-ab"},
	}); err != nil {
		t.Fatalf("SaveStructure (update+delete): %v", err)
	}

	structure, err = repo.SelectStructureByID(ctx, wf.ID, false)
	if err != nil {
		t.Fatal(err)
	}
	if len(structure.Nodes) != 1 || structure.Nodes[0].Name != "A renamed" {
		t.Fatalf("expected 1 renamed node, got %+v", structure.Nodes)
	}
	if len(structure.Edges) != 0 {
		t.Fatalf("expected the edge to be deleted, got %+v", structure.Edges)
	}
}

func TestWorkflowRepository_SelectStructureByID_IgnoreNote(t *testing.T) {
	repo, _, u := newTestWorkflowRepo(t)
	ctx := context.Background()
	wf, err := repo.Save(ctx, &models.Workflow{Name: "wf", UserID: u.ID}, true)
	if err != nil {
		t.Fatal(err)
	}
	if err := repo.SaveStructure(ctx, SaveStructureInput{
		WorkflowID: wf.ID,
		Nodes: []models.WorkflowNode{
			{ID: "in", WorkflowID: wf.ID, Kind: "input", Name: "IN"},
			{ID: "note", WorkflowID: wf.ID, Kind: "note", Name: "NOTE"},
		},
	}); err != nil {
		t.Fatal(err)
	}

	all, err := repo.SelectStructureByID(ctx, wf.ID, false)
	if err != nil {
		t.Fatal(err)
	}
	if len(all.Nodes) != 2 {
		t.Fatalf("expected both nodes without ignoreNote, got %d", len(all.Nodes))
	}

	filtered, err := repo.SelectStructureByID(ctx, wf.ID, true)
	if err != nil {
		t.Fatal(err)
	}
	if len(filtered.Nodes) != 1 || filtered.Nodes[0].Kind == "note" {
		t.Fatalf("expected the Note node excluded, got %+v", filtered.Nodes)
	}
}

func TestWorkflowRepository_SelectToolByIDs_OnlyPublishedWithInputSchema(t *testing.T) {
	repo, _, u := newTestWorkflowRepo(t)
	ctx := context.Background()

	published, err := repo.Save(ctx, &models.Workflow{Name: "Report Runner", UserID: u.ID, IsPublished: true}, true)
	if err != nil {
		t.Fatal(err)
	}
	customSchema := `{"type":"object","properties":{"topic":{"type":"string"}}}`
	if err := repo.SaveStructure(ctx, SaveStructureInput{
		WorkflowID: published.ID,
		Nodes: []models.WorkflowNode{
			{ID: "in", WorkflowID: published.ID, Kind: "input", Name: "IN", NodeConfig: []byte(`{"outputSchema":` + customSchema + `}`)},
		},
	}); err != nil {
		t.Fatal(err)
	}

	unpublished, err := repo.Save(ctx, &models.Workflow{Name: "Draft", UserID: u.ID, IsPublished: false}, true)
	if err != nil {
		t.Fatal(err)
	}
	if err := repo.SaveStructure(ctx, SaveStructureInput{
		WorkflowID: unpublished.ID,
		Nodes:      []models.WorkflowNode{{ID: "in2", WorkflowID: unpublished.ID, Kind: "input", Name: "IN"}},
	}); err != nil {
		t.Fatal(err)
	}

	got, err := repo.SelectToolByIDs(ctx, []string{published.ID, unpublished.ID, "does-not-exist"})
	if err != nil {
		t.Fatalf("SelectToolByIDs: %v", err)
	}
	if len(got) != 1 {
		t.Fatalf("expected only the published workflow, got %+v", got)
	}
	if got[0].ID != published.ID || got[0].Name != "Report Runner" {
		t.Fatalf("unexpected tool info: %+v", got[0])
	}
	if string(got[0].Schema) != customSchema {
		t.Fatalf("expected the Input node's own outputSchema, got %s", got[0].Schema)
	}
}

func TestWorkflowRepository_SelectToolByIDs_EmptyIDsYieldsNothing(t *testing.T) {
	repo, _, _ := newTestWorkflowRepo(t)
	got, err := repo.SelectToolByIDs(context.Background(), nil)
	if err != nil {
		t.Fatalf("SelectToolByIDs: %v", err)
	}
	if len(got) != 0 {
		t.Fatalf("expected no rows for empty ids, got %+v", got)
	}
}

func TestWorkflowRepository_Delete(t *testing.T) {
	repo, _, u := newTestWorkflowRepo(t)
	ctx := context.Background()
	wf, err := repo.Save(ctx, &models.Workflow{Name: "wf", UserID: u.ID}, true)
	if err != nil {
		t.Fatal(err)
	}
	if err := repo.Delete(ctx, wf.ID); err != nil {
		t.Fatalf("Delete: %v", err)
	}
	got, err := repo.SelectByID(ctx, wf.ID)
	if err != nil || got != nil {
		t.Fatalf("expected the workflow to be gone, got %v, err %v", got, err)
	}
	if err := repo.Delete(ctx, wf.ID); err == nil {
		t.Fatal("expected deleting a nonexistent workflow to error")
	}
}

func TestWorkflowRepository_SelectAllAndExecuteAbility(t *testing.T) {
	repo, gdb, owner := newTestWorkflowRepo(t)
	ctx := context.Background()
	other := &models.User{Name: "Bob", Email: "bob@example.com"}
	if err := gdb.Create(other).Error; err != nil {
		t.Fatal(err)
	}

	own, err := repo.Save(ctx, &models.Workflow{Name: "own", UserID: owner.ID}, true)
	if err != nil {
		t.Fatal(err)
	}
	published, err := repo.Save(ctx, &models.Workflow{Name: "published", UserID: other.ID, Visibility: "public", IsPublished: true}, true)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := repo.Save(ctx, &models.Workflow{Name: "private-other", UserID: other.ID, Visibility: "private"}, true); err != nil {
		t.Fatal(err)
	}

	all, err := repo.SelectAll(ctx, owner.ID)
	if err != nil {
		t.Fatal(err)
	}
	ids := map[string]bool{}
	for _, row := range all {
		ids[row.Workflow.ID] = true
	}
	if !ids[own.ID] {
		t.Fatal("expected the owner's own workflow in SelectAll")
	}
	if !ids[published.ID] {
		t.Fatal("expected the other user's public workflow in SelectAll")
	}

	execAbility, err := repo.SelectExecuteAbility(ctx, owner.ID)
	if err != nil {
		t.Fatal(err)
	}
	if len(execAbility) != 1 || execAbility[0].Workflow.ID != published.ID {
		t.Fatalf("expected only the published, non-private workflow, got %+v", execAbility)
	}
}

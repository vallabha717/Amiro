package repository

import (
	"context"
	"path/filepath"
	"testing"

	"gorm.io/datatypes"
	"gorm.io/gorm"

	"amiro/backend/internal/db"
	"amiro/backend/internal/db/models"
)

func newAgentTestEnv(t *testing.T) (*AgentRepository, *BookmarkRepository, *gorm.DB, *models.User, *models.User) {
	t.Helper()
	dsn := filepath.Join(t.TempDir(), "test.db")
	gdb, err := db.Open(db.DialectSQLite, dsn)
	if err != nil {
		t.Fatalf("db.Open: %v", err)
	}
	owner := &models.User{Name: "Ada", Email: "ada@example.com"}
	other := &models.User{Name: "Grace", Email: "grace@example.com"}
	for _, u := range []*models.User{owner, other} {
		if err := gdb.Create(u).Error; err != nil {
			t.Fatalf("create user: %v", err)
		}
	}
	return NewAgentRepository(gdb), NewBookmarkRepository(gdb), gdb, owner, other
}

func seedAgent(t *testing.T, repo *AgentRepository, userID, name, visibility string) *models.Agent {
	t.Helper()
	agent := &models.Agent{
		Name:         name,
		UserID:       userID,
		Visibility:   visibility,
		Instructions: datatypes.JSON(`{"role":"tester"}`),
	}
	if err := repo.Insert(context.Background(), agent); err != nil {
		t.Fatalf("Insert %q: %v", name, err)
	}
	return agent
}

func TestAgentRepository_InsertDefaultsVisibilityToPrivate(t *testing.T) {
	repo, _, _, owner, _ := newAgentTestEnv(t)

	agent := &models.Agent{Name: "No Visibility", UserID: owner.ID}
	if err := repo.Insert(context.Background(), agent); err != nil {
		t.Fatalf("Insert: %v", err)
	}
	if agent.Visibility != "private" {
		t.Fatalf("visibility = %q, want private", agent.Visibility)
	}
}

func TestAgentRepository_SelectByIDReturnsNilForAnotherUsersPrivateAgent(t *testing.T) {
	repo, _, _, owner, other := newAgentTestEnv(t)
	agent := seedAgent(t, repo, owner.ID, "Private", "private")

	got, err := repo.SelectByID(context.Background(), agent.ID, other.ID)
	if err != nil {
		t.Fatalf("SelectByID: %v", err)
	}
	if got != nil {
		t.Fatalf("got %+v, want nil", got)
	}
}

func TestAgentRepository_SelectByIDFindsAnotherUsersPublicAgent(t *testing.T) {
	repo, _, _, owner, other := newAgentTestEnv(t)
	agent := seedAgent(t, repo, owner.ID, "Public", "public")

	got, err := repo.SelectByID(context.Background(), agent.ID, other.ID)
	if err != nil {
		t.Fatalf("SelectByID: %v", err)
	}
	if got == nil || got.Name != "Public" {
		t.Fatalf("got %+v", got)
	}
	if string(got.Instructions) != `{"role":"tester"}` {
		t.Fatalf("instructions = %s -- the single-agent read must include them", got.Instructions)
	}
}

func TestAgentRepository_SelectByIDReportsTheCallersOwnBookmark(t *testing.T) {
	repo, bookmarks, _, owner, other := newAgentTestEnv(t)
	agent := seedAgent(t, repo, owner.ID, "Public", "public")
	ctx := context.Background()

	if err := bookmarks.Create(ctx, other.ID, agent.ID, BookmarkItemTypeAgent); err != nil {
		t.Fatalf("Create bookmark: %v", err)
	}

	bookmarked, err := repo.SelectByID(ctx, agent.ID, other.ID)
	if err != nil {
		t.Fatalf("SelectByID: %v", err)
	}
	if !bookmarked.IsBookmarked {
		t.Fatal("isBookmarked = false for the user who bookmarked it")
	}

	// ...and nobody else's.
	notBookmarked, _ := repo.SelectByID(ctx, agent.ID, owner.ID)
	if notBookmarked.IsBookmarked {
		t.Fatal("isBookmarked = true for a user who never bookmarked it")
	}
}

func TestAgentRepository_SelectAgentsAllReturnsOwnAndSharedButNotForeignPrivate(t *testing.T) {
	repo, _, _, owner, other := newAgentTestEnv(t)
	seedAgent(t, repo, owner.ID, "Mine", "private")
	seedAgent(t, repo, other.ID, "Theirs Public", "public")
	seedAgent(t, repo, other.ID, "Theirs Readonly", "readonly")
	seedAgent(t, repo, other.ID, "Theirs Private", "private")

	rows, err := repo.SelectAgents(context.Background(), owner.ID, []string{"all"}, 50)
	if err != nil {
		t.Fatalf("SelectAgents: %v", err)
	}

	names := map[string]bool{}
	for _, row := range rows {
		names[row.Name] = true
	}
	for _, want := range []string{"Mine", "Theirs Public", "Theirs Readonly"} {
		if !names[want] {
			t.Fatalf("missing %q from %v", want, names)
		}
	}
	if names["Theirs Private"] {
		t.Fatal("another user's private agent leaked into the list")
	}
}

func TestAgentRepository_SelectAgentsOrdersOwnAgentsFirst(t *testing.T) {
	repo, _, _, owner, other := newAgentTestEnv(t)
	// Seeded before the caller's own, so a plain created_at DESC ordering
	// would put it first -- the CASE arm is what stops that.
	seedAgent(t, repo, other.ID, "Theirs", "public")
	seedAgent(t, repo, owner.ID, "Mine", "private")

	rows, err := repo.SelectAgents(context.Background(), owner.ID, []string{"all"}, 50)
	if err != nil {
		t.Fatalf("SelectAgents: %v", err)
	}
	if len(rows) != 2 || rows[0].Name != "Mine" {
		t.Fatalf("order = %v, want the caller's own agent first", agentNames(rows))
	}
}

func TestAgentRepository_SelectAgentsMineExcludesSharedAgents(t *testing.T) {
	repo, _, _, owner, other := newAgentTestEnv(t)
	seedAgent(t, repo, owner.ID, "Mine", "private")
	seedAgent(t, repo, other.ID, "Theirs", "public")

	rows, err := repo.SelectAgents(context.Background(), owner.ID, []string{"mine"}, 50)
	if err != nil {
		t.Fatalf("SelectAgents: %v", err)
	}
	if len(rows) != 1 || rows[0].Name != "Mine" {
		t.Fatalf("got %v", agentNames(rows))
	}
}

func TestAgentRepository_SelectAgentsBookmarkedReturnsOnlyBookmarkedSharedAgents(t *testing.T) {
	repo, bookmarks, _, owner, other := newAgentTestEnv(t)
	ctx := context.Background()
	bookmarked := seedAgent(t, repo, other.ID, "Bookmarked", "public")
	seedAgent(t, repo, other.ID, "Not Bookmarked", "public")
	// The caller's own agent must not show up even though "bookmarked"
	// sounds inclusive -- the TS filter ANDs in userId <> currentUserId.
	seedAgent(t, repo, owner.ID, "Mine", "private")

	if err := bookmarks.Create(ctx, owner.ID, bookmarked.ID, BookmarkItemTypeAgent); err != nil {
		t.Fatalf("Create bookmark: %v", err)
	}

	rows, err := repo.SelectAgents(ctx, owner.ID, []string{"bookmarked"}, 50)
	if err != nil {
		t.Fatalf("SelectAgents: %v", err)
	}
	if len(rows) != 1 || rows[0].Name != "Bookmarked" {
		t.Fatalf("got %v", agentNames(rows))
	}
}

func TestAgentRepository_SelectAgentsAllOverridesEveryOtherFilter(t *testing.T) {
	repo, _, _, owner, other := newAgentTestEnv(t)
	seedAgent(t, repo, owner.ID, "Mine", "private")
	seedAgent(t, repo, other.ID, "Theirs", "public")

	// "mine" alone would return one row; "all" appearing anywhere in the
	// list must widen it to both (agent-repository.pg.ts:191's break).
	rows, err := repo.SelectAgents(context.Background(), owner.ID, []string{"mine", "all"}, 50)
	if err != nil {
		t.Fatalf("SelectAgents: %v", err)
	}
	if len(rows) != 2 {
		t.Fatalf("got %v, want both agents", agentNames(rows))
	}
}

func TestAgentRepository_SelectAgentsIncludesOwnerDisplayFields(t *testing.T) {
	repo, _, _, owner, _ := newAgentTestEnv(t)
	seedAgent(t, repo, owner.ID, "Mine", "private")

	rows, err := repo.SelectAgents(context.Background(), owner.ID, nil, 50)
	if err != nil {
		t.Fatalf("SelectAgents: %v", err)
	}
	if rows[0].UserName != "Ada" {
		t.Fatalf("userName = %q, want Ada", rows[0].UserName)
	}
}

func TestAgentRepository_SelectAgentsRespectsLimit(t *testing.T) {
	repo, _, _, owner, _ := newAgentTestEnv(t)
	for _, name := range []string{"a", "b", "c"} {
		seedAgent(t, repo, owner.ID, name, "private")
	}

	rows, err := repo.SelectAgents(context.Background(), owner.ID, nil, 2)
	if err != nil {
		t.Fatalf("SelectAgents: %v", err)
	}
	if len(rows) != 2 {
		t.Fatalf("got %d rows, want 2", len(rows))
	}
}

func TestAgentRepository_UpdateLeavesOmittedFieldsAlone(t *testing.T) {
	repo, _, _, owner, _ := newAgentTestEnv(t)
	agent := seedAgent(t, repo, owner.ID, "Original", "private")

	newName := "Renamed"
	updated, err := repo.Update(context.Background(), agent.ID, owner.ID, AgentUpdate{Name: &newName})
	if err != nil {
		t.Fatalf("Update: %v", err)
	}
	if updated.Name != "Renamed" {
		t.Fatalf("name = %q", updated.Name)
	}
	if string(updated.Instructions) != `{"role":"tester"}` {
		t.Fatalf("instructions = %s -- an omitted field must not be blanked", updated.Instructions)
	}
	if updated.Visibility != "private" {
		t.Fatalf("visibility = %q -- an omitted field must not be blanked", updated.Visibility)
	}
}

func TestAgentRepository_UpdateReturnsNilForAnotherUsersPrivateAgent(t *testing.T) {
	repo, _, _, owner, other := newAgentTestEnv(t)
	agent := seedAgent(t, repo, owner.ID, "Private", "private")

	newName := "Hijacked"
	updated, err := repo.Update(context.Background(), agent.ID, other.ID, AgentUpdate{Name: &newName})
	if err != nil {
		t.Fatalf("Update: %v", err)
	}
	if updated != nil {
		t.Fatalf("got %+v, want nil", updated)
	}
}

func TestAgentRepository_DeleteIsOwnerOnly(t *testing.T) {
	repo, _, _, owner, other := newAgentTestEnv(t)
	ctx := context.Background()
	agent := seedAgent(t, repo, owner.ID, "Public", "public")

	if err := repo.Delete(ctx, agent.ID, other.ID); err != nil {
		t.Fatalf("Delete: %v", err)
	}
	if got, _ := repo.SelectByID(ctx, agent.ID, owner.ID); got == nil {
		t.Fatal("a non-owner deleted a public agent")
	}

	if err := repo.Delete(ctx, agent.ID, owner.ID); err != nil {
		t.Fatalf("Delete: %v", err)
	}
	if got, _ := repo.SelectByID(ctx, agent.ID, owner.ID); got != nil {
		t.Fatal("owner delete did not remove the agent")
	}
}

func TestAgentRepository_CheckAccessMatrix(t *testing.T) {
	repo, _, _, owner, other := newAgentTestEnv(t)
	ctx := context.Background()
	private := seedAgent(t, repo, owner.ID, "Private", "private")
	public := seedAgent(t, repo, owner.ID, "Public", "public")
	readonly := seedAgent(t, repo, owner.ID, "Readonly", "readonly")

	cases := []struct {
		name        string
		agentID     string
		userID      string
		destructive bool
		want        bool
	}{
		{"owner reads own private", private.ID, owner.ID, false, true},
		{"owner deletes own private", private.ID, owner.ID, true, true},
		{"stranger reads private", private.ID, other.ID, false, false},
		{"stranger reads public", public.ID, other.ID, false, true},
		{"stranger deletes public", public.ID, other.ID, true, false},
		// readonly is *not* in checkAccess's allow-list, unlike
		// selectAgentById's -- a readonly agent is visible but not writable
		// through this gate at all (agent-repository.pg.ts:250).
		{"stranger writes readonly", readonly.ID, other.ID, false, false},
		{"missing agent", "no-such-id", owner.ID, false, false},
	}
	for _, tc := range cases {
		got, err := repo.CheckAccess(ctx, tc.agentID, tc.userID, tc.destructive)
		if err != nil {
			t.Fatalf("%s: CheckAccess: %v", tc.name, err)
		}
		if got != tc.want {
			t.Fatalf("%s: got %v, want %v", tc.name, got, tc.want)
		}
	}
}

func agentNames(rows []AgentWithMeta) []string {
	out := make([]string, 0, len(rows))
	for _, row := range rows {
		out = append(out, row.Name)
	}
	return out
}

// Package repository is a cross-cutting suite: it runs Phase 6's
// hand-written SQL against a real database of each dialect, because that
// SQL is where the two dialects can actually diverge.
//
// Every other repository test in this tree is colocated and SQLite-only,
// which is fine for logic. These queries are different: they use aliased
// tables, a quoted "user" identifier (a reserved word on Postgres),
// GROUP BY with a full non-aggregated column list (Postgres rejects a
// partial one, SQLite silently accepts it), boolean-producing predicates in
// a SELECT list (`b.id IS NOT NULL AS is_bookmarked` -- a real boolean on
// Postgres, an integer on SQLite), and correlated subqueries whose result
// column type the driver has to infer. Any of those can pass on SQLite and
// fail on Postgres, which is exactly the class of bug Phase 1 already hit
// once with JSONB canonicalization.
//
// The Postgres half is gated on BACKENDGO_TEST_POSTGRES_URL and skips when
// unset -- the same pattern tests/migration uses.
package repository

import (
	"context"
	"os"
	"path/filepath"
	"testing"

	"gorm.io/datatypes"
	"gorm.io/gorm"

	"amiro/backend/internal/db"
	"amiro/backend/internal/db/models"
	"amiro/backend/internal/db/repository"
	"amiro/backend/internal/user"
)

func TestPhase6Queries_RunOnSQLite(t *testing.T) {
	dsn := filepath.Join(t.TempDir(), "dialect.db")
	runPhase6Queries(t, db.DialectSQLite, dsn)
}

func TestPhase6Queries_RunOnPostgres(t *testing.T) {
	dsn := os.Getenv("BACKENDGO_TEST_POSTGRES_URL")
	if dsn == "" {
		t.Skip("BACKENDGO_TEST_POSTGRES_URL not set; skipping the Postgres dialect check")
	}
	runPhase6Queries(t, db.DialectPostgres, dsn)
}

// runPhase6Queries drives every query Phase 6 added that contains
// hand-written SQL, and asserts on the results -- not merely that the
// statement executed, since a dialect difference can just as easily
// produce a wrong answer as an error.
func runPhase6Queries(t *testing.T, driver, dsn string) {
	t.Helper()

	gdb, err := db.Open(driver, dsn)
	if err != nil {
		t.Fatalf("Open(%q): %v", driver, err)
	}
	sqlDB, err := gdb.DB()
	if err != nil {
		t.Fatalf("underlying sql.DB: %v", err)
	}
	defer sqlDB.Close()

	ctx := context.Background()
	owner, other := seedUsers(t, gdb)

	agents := repository.NewAgentRepository(gdb)
	bookmarks := repository.NewBookmarkRepository(gdb)
	archives := repository.NewArchiveRepository(gdb)
	chats := repository.NewChatRepository(gdb)
	users := repository.NewUserRepository(gdb)
	exports := repository.NewChatExportRepository(gdb, chats)

	// --- agent: aliased joins + a boolean-producing SELECT expression +
	// a parameterized CASE in the ORDER BY.
	mine := &models.Agent{Name: "Mine", UserID: owner.ID, Visibility: "private",
		Instructions: datatypes.JSON(`{"role":"tester"}`)}
	theirs := &models.Agent{Name: "Theirs", UserID: other.ID, Visibility: "public"}
	for _, agent := range []*models.Agent{theirs, mine} {
		if err := agents.Insert(ctx, agent); err != nil {
			t.Fatalf("insert agent: %v", err)
		}
	}
	if err := bookmarks.Create(ctx, owner.ID, theirs.ID, repository.BookmarkItemTypeAgent); err != nil {
		t.Fatalf("create bookmark: %v", err)
	}

	list, err := agents.SelectAgents(ctx, owner.ID, []string{"all"}, 50)
	if err != nil {
		t.Fatalf("SelectAgents: %v", err)
	}
	if len(list) != 2 {
		t.Fatalf("SelectAgents returned %d rows, want 2", len(list))
	}
	if list[0].Name != "Mine" {
		t.Fatalf("ORDER BY put %q first; the caller's own agent should lead", list[0].Name)
	}
	if list[0].UserName != "Ada" {
		t.Fatalf("userName = %q -- the quoted \"user\" join did not resolve", list[0].UserName)
	}
	// is_bookmarked is a real boolean on Postgres and an integer on SQLite;
	// both must land in the Go bool correctly.
	byName := map[string]repository.AgentWithMeta{}
	for _, row := range list {
		byName[row.Name] = row
	}
	if !byName["Theirs"].IsBookmarked {
		t.Fatal("isBookmarked = false for a bookmarked agent")
	}
	if byName["Mine"].IsBookmarked {
		t.Fatal("isBookmarked = true for an agent that was never bookmarked")
	}

	bookmarked, err := agents.SelectAgents(ctx, owner.ID, []string{"bookmarked"}, 50)
	if err != nil {
		t.Fatalf("SelectAgents(bookmarked): %v", err)
	}
	if len(bookmarked) != 1 || bookmarked[0].Name != "Theirs" {
		t.Fatalf("bookmarked filter returned %d rows: %+v", len(bookmarked), bookmarked)
	}

	single, err := agents.SelectByID(ctx, theirs.ID, owner.ID)
	if err != nil {
		t.Fatalf("SelectByID: %v", err)
	}
	if single == nil || !single.IsBookmarked {
		t.Fatalf("SelectByID = %+v", single)
	}

	// --- archive: GROUP BY with a full column list + a LEFT JOIN COUNT.
	full := &models.Archive{Name: "Full", UserID: owner.ID}
	empty := &models.Archive{Name: "Empty", UserID: owner.ID}
	for _, archive := range []*models.Archive{full, empty} {
		if err := archives.Create(ctx, archive); err != nil {
			t.Fatalf("create archive: %v", err)
		}
	}
	thread := &models.ChatThread{Title: "Thread", UserID: owner.ID}
	if err := chats.InsertThread(ctx, thread); err != nil {
		t.Fatalf("InsertThread: %v", err)
	}
	if _, err := archives.AddItem(ctx, full.ID, thread.ID, owner.ID); err != nil {
		t.Fatalf("AddItem: %v", err)
	}

	counted, err := archives.GetByUserID(ctx, owner.ID)
	if err != nil {
		t.Fatalf("GetByUserID: %v", err)
	}
	counts := map[string]int64{}
	for _, row := range counted {
		counts[row.Name] = row.ItemCount
	}
	if counts["Full"] != 1 || counts["Empty"] != 0 || len(counts) != 2 {
		t.Fatalf("archive item counts = %v, want Full:1 Empty:0", counts)
	}

	itemArchives, err := archives.GetItemArchives(ctx, thread.ID, owner.ID)
	if err != nil {
		t.Fatalf("GetItemArchives: %v", err)
	}
	if len(itemArchives) != 1 || itemArchives[0].Name != "Full" {
		t.Fatalf("GetItemArchives = %+v", itemArchives)
	}

	// --- thread list: the correlated subquery whose result column type the
	// driver has to infer as a timestamp.
	msg := &models.ChatMessage{ID: "m1", ThreadID: thread.ID, Role: "user",
		Parts: datatypes.JSON(`[{"type":"text","text":"hi"}]`)}
	if err := chats.UpsertMessage(ctx, msg); err != nil {
		t.Fatalf("UpsertMessage: %v", err)
	}
	empties := &models.ChatThread{Title: "No messages", UserID: owner.ID}
	if err := chats.InsertThread(ctx, empties); err != nil {
		t.Fatalf("InsertThread: %v", err)
	}

	threads, err := chats.SelectThreadsByUserID(ctx, owner.ID)
	if err != nil {
		t.Fatalf("SelectThreadsByUserID: %v", err)
	}
	if len(threads) != 2 {
		t.Fatalf("got %d threads, want 2", len(threads))
	}
	if threads[0].ChatThread.ID != thread.ID {
		t.Fatalf("the thread with a message did not sort first: %+v", threads)
	}
	if threads[0].LastMessageAt == nil {
		t.Fatal("lastMessageAt = nil for a thread that has a message -- the subquery's type did not survive")
	}
	if threads[1].LastMessageAt != nil {
		t.Fatalf("lastMessageAt = %v for a thread with no messages", threads[1].LastMessageAt)
	}

	// --- user: the newest-session lookup and the JSON preferences column.
	if _, err := users.UpdatePreferences(ctx, owner.ID, user.Preferences{DisplayName: "Ada L."}); err != nil {
		t.Fatalf("UpdatePreferences: %v", err)
	}
	prefs, err := users.GetPreferences(ctx, owner.ID)
	if err != nil {
		t.Fatalf("GetPreferences: %v", err)
	}
	if prefs == nil || prefs.DisplayName != "Ada L." {
		t.Fatalf("preferences = %+v", prefs)
	}

	detail, err := users.GetByID(ctx, owner.ID)
	if err != nil {
		t.Fatalf("GetByID: %v", err)
	}
	if detail == nil || detail.LastLogin == nil {
		t.Fatalf("user detail = %+v, want a lastLogin from the seeded session", detail)
	}
	if detail.User.Password != nil {
		t.Fatal("password hash survived GetByID")
	}

	// --- chat export: another quoted-"user" join, another GROUP BY COUNT,
	// and the comment tree.
	export := &models.ChatExport{Title: "Shared", ExporterID: owner.ID,
		Messages: datatypes.JSON(`[{"id":"m1","role":"user","parts":[]}]`)}
	if err := gdb.Create(export).Error; err != nil {
		t.Fatalf("create export: %v", err)
	}
	parent := &models.ChatExportComment{ExportID: export.ID, AuthorID: owner.ID, Content: datatypes.JSON(`{"n":1}`)}
	if err := exports.InsertComment(ctx, parent); err != nil {
		t.Fatalf("InsertComment: %v", err)
	}
	reply := &models.ChatExportComment{ExportID: export.ID, AuthorID: other.ID, ParentID: &parent.ID, Content: datatypes.JSON(`{"n":2}`)}
	if err := exports.InsertComment(ctx, reply); err != nil {
		t.Fatalf("InsertComment: %v", err)
	}

	summaries, err := exports.SelectSummaryByExporterID(ctx, owner.ID)
	if err != nil {
		t.Fatalf("SelectSummaryByExporterID: %v", err)
	}
	if len(summaries) != 1 || summaries[0].CommentCount != 2 {
		t.Fatalf("summaries = %+v, want one export with 2 comments", summaries)
	}

	withUser, err := exports.SelectByIDWithUser(ctx, export.ID)
	if err != nil {
		t.Fatalf("SelectByIDWithUser: %v", err)
	}
	if withUser == nil || withUser.ExporterName == nil || *withUser.ExporterName != "Ada" {
		t.Fatalf("export with user = %+v", withUser)
	}

	comments, err := exports.SelectCommentsByExportID(ctx, export.ID, owner.ID)
	if err != nil {
		t.Fatalf("SelectCommentsByExportID: %v", err)
	}
	if len(comments) != 1 || len(comments[0].Replies) != 1 {
		t.Fatalf("comment tree = %+v", comments)
	}
	if !comments[0].IsOwner || comments[0].Replies[0].IsOwner {
		t.Fatalf("isOwner flags are wrong: %+v", comments[0])
	}
}

func seedUsers(t *testing.T, gdb *gorm.DB) (*models.User, *models.User) {
	t.Helper()
	password := "hashed"
	owner := &models.User{Name: "Ada", Email: "ada@example.com", Password: &password}
	other := &models.User{Name: "Grace", Email: "grace@example.com"}
	for _, u := range []*models.User{owner, other} {
		if err := gdb.Create(u).Error; err != nil {
			t.Fatalf("create user: %v", err)
		}
	}
	session := &models.Session{UserID: owner.ID, Token: "session-" + owner.ID}
	if err := gdb.Create(session).Error; err != nil {
		t.Fatalf("create session: %v", err)
	}
	return owner, other
}

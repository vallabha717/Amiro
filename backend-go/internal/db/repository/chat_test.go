package repository

import (
	"context"
	"path/filepath"
	"testing"
	"time"

	"gorm.io/datatypes"
	"gorm.io/gorm"

	"betterchatbot/backend/internal/db"
	"betterchatbot/backend/internal/db/models"
)

func newTestChatRepo(t *testing.T) (*ChatRepository, *gorm.DB, *models.User) {
	t.Helper()
	dsn := filepath.Join(t.TempDir(), "test.db")
	gdb, err := db.Open(db.DialectSQLite, dsn)
	if err != nil {
		t.Fatalf("db.Open: %v", err)
	}
	u := &models.User{Name: "Ada", Email: "ada@example.com"}
	if err := gdb.WithContext(context.Background()).Create(u).Error; err != nil {
		t.Fatalf("create user: %v", err)
	}
	return NewChatRepository(gdb), gdb, u
}

func TestChatRepository_InsertAndSelectThread(t *testing.T) {
	repo, _, u := newTestChatRepo(t)
	ctx := context.Background()

	thread := &models.ChatThread{ID: "thread-1", Title: "Hello", UserID: u.ID}
	if err := repo.InsertThread(ctx, thread); err != nil {
		t.Fatalf("InsertThread: %v", err)
	}

	got, err := repo.SelectThread(ctx, "thread-1")
	if err != nil {
		t.Fatalf("SelectThread: %v", err)
	}
	if got == nil || got.Title != "Hello" {
		t.Fatalf("got %+v", got)
	}
}

func TestChatRepository_SelectThreadReturnsNilForMissingID(t *testing.T) {
	repo, _, _ := newTestChatRepo(t)
	got, err := repo.SelectThread(context.Background(), "does-not-exist")
	if err != nil {
		t.Fatalf("SelectThread: %v", err)
	}
	if got != nil {
		t.Fatalf("got %+v, want nil", got)
	}
}

func TestChatRepository_SelectThreadDetailsReturnsNilForEmptyID(t *testing.T) {
	repo, _, _ := newTestChatRepo(t)
	got, err := repo.SelectThreadDetails(context.Background(), "")
	if err != nil {
		t.Fatalf("SelectThreadDetails: %v", err)
	}
	if got != nil {
		t.Fatalf("got %+v, want nil", got)
	}
}

func TestChatRepository_SelectThreadDetailsIncludesOwnerPreferencesAndMessages(t *testing.T) {
	repo, gdb, u := newTestChatRepo(t)
	ctx := context.Background()

	prefsJSON := datatypes.JSON(`{"botName":"Vega"}`)
	if err := gdb.Model(u).Update("preferences", prefsJSON).Error; err != nil {
		t.Fatalf("set preferences: %v", err)
	}

	thread := &models.ChatThread{ID: "thread-1", Title: "", UserID: u.ID}
	if err := repo.InsertThread(ctx, thread); err != nil {
		t.Fatalf("InsertThread: %v", err)
	}
	msg := &models.ChatMessage{ID: "msg-1", ThreadID: "thread-1", Role: "user", Parts: datatypes.JSON(`[{"type":"text","text":"hi"}]`)}
	if err := repo.UpsertMessage(ctx, msg); err != nil {
		t.Fatalf("UpsertMessage: %v", err)
	}

	details, err := repo.SelectThreadDetails(ctx, "thread-1")
	if err != nil {
		t.Fatalf("SelectThreadDetails: %v", err)
	}
	if details == nil {
		t.Fatal("got nil details")
	}
	if string(details.Preferences) != string(prefsJSON) {
		t.Fatalf("preferences = %s, want %s", details.Preferences, prefsJSON)
	}
	if len(details.Messages) != 1 || details.Messages[0].ID != "msg-1" {
		t.Fatalf("messages = %+v", details.Messages)
	}
}

func TestChatRepository_UpsertMessageInsertsThenUpdatesPartsOnConflict(t *testing.T) {
	repo, _, u := newTestChatRepo(t)
	ctx := context.Background()
	_ = repo.InsertThread(ctx, &models.ChatThread{ID: "thread-1", UserID: u.ID})

	msg := &models.ChatMessage{ID: "msg-1", ThreadID: "thread-1", Role: "user", Parts: datatypes.JSON(`[{"type":"text","text":"v1"}]`)}
	if err := repo.UpsertMessage(ctx, msg); err != nil {
		t.Fatalf("first UpsertMessage: %v", err)
	}

	updated := &models.ChatMessage{ID: "msg-1", ThreadID: "thread-1", Role: "user", Parts: datatypes.JSON(`[{"type":"text","text":"v2"}]`)}
	if err := repo.UpsertMessage(ctx, updated); err != nil {
		t.Fatalf("second UpsertMessage: %v", err)
	}

	messages, err := repo.SelectMessagesByThreadID(ctx, "thread-1")
	if err != nil {
		t.Fatalf("SelectMessagesByThreadID: %v", err)
	}
	if len(messages) != 1 {
		t.Fatalf("got %d messages, want 1 (upsert should update, not duplicate)", len(messages))
	}
	if string(messages[0].Parts) != `[{"type":"text","text":"v2"}]` {
		t.Fatalf("parts = %s, want the updated value", messages[0].Parts)
	}
}

func TestChatRepository_UpsertThreadInsertsThenUpdatesTitleOnConflict(t *testing.T) {
	repo, _, u := newTestChatRepo(t)
	ctx := context.Background()

	if err := repo.UpsertThread(ctx, &models.ChatThread{ID: "thread-1", Title: "first", UserID: u.ID}); err != nil {
		t.Fatalf("first UpsertThread: %v", err)
	}
	if err := repo.UpsertThread(ctx, &models.ChatThread{ID: "thread-1", Title: "second", UserID: u.ID}); err != nil {
		t.Fatalf("second UpsertThread: %v", err)
	}

	got, err := repo.SelectThread(ctx, "thread-1")
	if err != nil {
		t.Fatalf("SelectThread: %v", err)
	}
	if got.Title != "second" {
		t.Fatalf("title = %q, want %q", got.Title, "second")
	}
}

func TestChatRepository_DeleteThreadRemovesThreadAndItsMessages(t *testing.T) {
	repo, _, u := newTestChatRepo(t)
	ctx := context.Background()
	_ = repo.InsertThread(ctx, &models.ChatThread{ID: "thread-1", UserID: u.ID})
	_ = repo.UpsertMessage(ctx, &models.ChatMessage{ID: "msg-1", ThreadID: "thread-1", Role: "user", Parts: datatypes.JSON(`[]`)})

	if err := repo.DeleteThread(ctx, "thread-1"); err != nil {
		t.Fatalf("DeleteThread: %v", err)
	}

	thread, err := repo.SelectThread(ctx, "thread-1")
	if err != nil {
		t.Fatalf("SelectThread: %v", err)
	}
	if thread != nil {
		t.Fatalf("thread still exists: %+v", thread)
	}
	messages, err := repo.SelectMessagesByThreadID(ctx, "thread-1")
	if err != nil {
		t.Fatalf("SelectMessagesByThreadID: %v", err)
	}
	if len(messages) != 0 {
		t.Fatalf("got %d messages, want 0 after thread delete", len(messages))
	}
}

func TestChatRepository_DeleteMessagesByChatIDAfterTimestampDeletesTargetAndLater(t *testing.T) {
	repo, _, u := newTestChatRepo(t)
	ctx := context.Background()
	_ = repo.InsertThread(ctx, &models.ChatThread{ID: "thread-1", UserID: u.ID})

	_ = repo.UpsertMessage(ctx, &models.ChatMessage{ID: "msg-1", ThreadID: "thread-1", Role: "user", Parts: datatypes.JSON(`[]`)})
	// autoCreateTime has microsecond+ resolution (proven in
	// driver_test.go/migrate_test.go's own ordering assertions), so a
	// second natural insert right after the first already sorts later --
	// no manual backdating needed (and manually overwriting a time.Time
	// column via a raw string goes through a different GORM serialization
	// path than a normal insert/query, which desyncs the stored format
	// from what a later query parameter binds -- not worth the false
	// bug signal).
	time.Sleep(time.Millisecond)
	_ = repo.UpsertMessage(ctx, &models.ChatMessage{ID: "msg-2", ThreadID: "thread-1", Role: "assistant", Parts: datatypes.JSON(`[]`)})

	if err := repo.DeleteMessagesByChatIDAfterTimestamp(ctx, "msg-2"); err != nil {
		t.Fatalf("DeleteMessagesByChatIDAfterTimestamp: %v", err)
	}

	messages, err := repo.SelectMessagesByThreadID(ctx, "thread-1")
	if err != nil {
		t.Fatalf("SelectMessagesByThreadID: %v", err)
	}
	if len(messages) != 1 || messages[0].ID != "msg-1" {
		t.Fatalf("got %+v, want only msg-1 to remain", messages)
	}
}

func TestChatRepository_DeleteMessagesByChatIDAfterTimestampNoOpsForMissingMessage(t *testing.T) {
	repo, _, _ := newTestChatRepo(t)
	if err := repo.DeleteMessagesByChatIDAfterTimestamp(context.Background(), "does-not-exist"); err != nil {
		t.Fatalf("expected no error for a missing message id, got %v", err)
	}
}

func TestChatRepository_DeleteAllThreadsRemovesEveryThreadForUser(t *testing.T) {
	repo, _, u := newTestChatRepo(t)
	ctx := context.Background()
	_ = repo.InsertThread(ctx, &models.ChatThread{ID: "thread-1", UserID: u.ID})
	_ = repo.InsertThread(ctx, &models.ChatThread{ID: "thread-2", UserID: u.ID})

	if err := repo.DeleteAllThreads(ctx, u.ID); err != nil {
		t.Fatalf("DeleteAllThreads: %v", err)
	}

	for _, id := range []string{"thread-1", "thread-2"} {
		got, err := repo.SelectThread(ctx, id)
		if err != nil {
			t.Fatalf("SelectThread(%q): %v", id, err)
		}
		if got != nil {
			t.Fatalf("thread %q still exists", id)
		}
	}
}

func TestChatRepository_CheckAccessTrueForOwnerFalseOtherwise(t *testing.T) {
	repo, _, u := newTestChatRepo(t)
	ctx := context.Background()
	_ = repo.InsertThread(ctx, &models.ChatThread{ID: "thread-1", UserID: u.ID})

	ok, err := repo.CheckAccess(ctx, "thread-1", u.ID)
	if err != nil {
		t.Fatalf("CheckAccess: %v", err)
	}
	if !ok {
		t.Fatal("expected the owner to have access")
	}

	ok, err = repo.CheckAccess(ctx, "thread-1", "someone-else")
	if err != nil {
		t.Fatalf("CheckAccess: %v", err)
	}
	if ok {
		t.Fatal("expected a non-owner to be denied access")
	}
}

func TestChatRepository_SelectThreadsByUserIDOrdersNewestActivityFirst(t *testing.T) {
	repo, _, u := newTestChatRepo(t)
	ctx := context.Background()

	for _, id := range []string{"quiet", "busy"} {
		if err := repo.InsertThread(ctx, &models.ChatThread{ID: id, Title: id, UserID: u.ID}); err != nil {
			t.Fatalf("InsertThread: %v", err)
		}
	}
	// "quiet" gets the older message, "busy" the newer one, so ordering by
	// the thread's own created_at would produce the opposite result.
	seedMessage(t, repo, "quiet", "m1")
	time.Sleep(5 * time.Millisecond)
	seedMessage(t, repo, "busy", "m2")

	rows, err := repo.SelectThreadsByUserID(ctx, u.ID)
	if err != nil {
		t.Fatalf("SelectThreadsByUserID: %v", err)
	}
	if len(rows) != 2 || rows[0].ChatThread.ID != "busy" {
		t.Fatalf("order = %v, want the most recently active thread first", threadIDs(rows))
	}
}

// A brand-new thread with no messages must still appear -- it's the one a
// user is looking at right after starting a chat.
func TestChatRepository_SelectThreadsByUserIDIncludesThreadsWithNoMessages(t *testing.T) {
	repo, _, u := newTestChatRepo(t)
	ctx := context.Background()
	_ = repo.InsertThread(ctx, &models.ChatThread{ID: "empty", Title: "empty", UserID: u.ID})

	rows, err := repo.SelectThreadsByUserID(ctx, u.ID)
	if err != nil {
		t.Fatalf("SelectThreadsByUserID: %v", err)
	}
	if len(rows) != 1 {
		t.Fatalf("got %d rows, want 1", len(rows))
	}
	if rows[0].LastMessageAt != nil {
		t.Fatalf("lastMessageAt = %v, want nil", rows[0].LastMessageAt)
	}
}

// An empty thread sorts last regardless of dialect -- Postgres and SQLite
// disagree on where SQL puts NULLs in a DESC ordering, which is why the
// sort happens in Go.
func TestChatRepository_SelectThreadsByUserIDSortsMessagelessThreadsLast(t *testing.T) {
	repo, _, u := newTestChatRepo(t)
	ctx := context.Background()
	_ = repo.InsertThread(ctx, &models.ChatThread{ID: "empty", Title: "empty", UserID: u.ID})
	_ = repo.InsertThread(ctx, &models.ChatThread{ID: "active", Title: "active", UserID: u.ID})
	seedMessage(t, repo, "active", "m1")

	rows, err := repo.SelectThreadsByUserID(ctx, u.ID)
	if err != nil {
		t.Fatalf("SelectThreadsByUserID: %v", err)
	}
	if rows[0].ChatThread.ID != "active" || rows[1].ChatThread.ID != "empty" {
		t.Fatalf("order = %v, want [active empty]", threadIDs(rows))
	}
}

func TestChatRepository_SelectThreadsByUserIDExcludesOtherUsersThreads(t *testing.T) {
	repo, gdb, u := newTestChatRepo(t)
	ctx := context.Background()
	other := &models.User{Name: "Grace", Email: "grace@example.com"}
	if err := gdb.Create(other).Error; err != nil {
		t.Fatalf("create user: %v", err)
	}
	_ = repo.InsertThread(ctx, &models.ChatThread{ID: "mine", Title: "mine", UserID: u.ID})
	_ = repo.InsertThread(ctx, &models.ChatThread{ID: "theirs", Title: "theirs", UserID: other.ID})

	rows, err := repo.SelectThreadsByUserID(ctx, u.ID)
	if err != nil {
		t.Fatalf("SelectThreadsByUserID: %v", err)
	}
	if len(rows) != 1 || rows[0].ChatThread.ID != "mine" {
		t.Fatalf("got %v", threadIDs(rows))
	}
}

// deleteThread's archive_item step was left out in Phase 3 (no archive
// repository existed yet) and added in Phase 6 -- without it, deleting an
// archived thread leaves an archive pointing at a thread that's gone.
func TestChatRepository_DeleteThreadAlsoRemovesItFromEveryArchive(t *testing.T) {
	repo, gdb, u := newTestChatRepo(t)
	ctx := context.Background()
	archives := NewArchiveRepository(gdb)

	_ = repo.InsertThread(ctx, &models.ChatThread{ID: "t1", Title: "t1", UserID: u.ID})
	archive := &models.Archive{Name: "A", UserID: u.ID}
	if err := archives.Create(ctx, archive); err != nil {
		t.Fatalf("Create archive: %v", err)
	}
	if _, err := archives.AddItem(ctx, archive.ID, "t1", u.ID); err != nil {
		t.Fatalf("AddItem: %v", err)
	}

	if err := repo.DeleteThread(ctx, "t1"); err != nil {
		t.Fatalf("DeleteThread: %v", err)
	}

	items, err := archives.GetItems(ctx, archive.ID)
	if err != nil {
		t.Fatalf("GetItems: %v", err)
	}
	if len(items) != 0 {
		t.Fatalf("archive still holds %d items pointing at a deleted thread", len(items))
	}
}

func seedMessage(t *testing.T, repo *ChatRepository, threadID, messageID string) {
	t.Helper()
	msg := &models.ChatMessage{
		ID:       messageID,
		ThreadID: threadID,
		Role:     "user",
		Parts:    datatypes.JSON(`[{"type":"text","text":"hi"}]`),
	}
	if err := repo.UpsertMessage(context.Background(), msg); err != nil {
		t.Fatalf("UpsertMessage: %v", err)
	}
}

func threadIDs(rows []ThreadWithLastMessage) []string {
	out := make([]string, 0, len(rows))
	for _, row := range rows {
		out = append(out, row.ChatThread.ID)
	}
	return out
}

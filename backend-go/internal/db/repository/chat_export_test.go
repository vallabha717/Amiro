package repository

import (
	"context"
	"encoding/json"
	"path/filepath"
	"testing"
	"time"

	"gorm.io/datatypes"
	"gorm.io/gorm"

	"amiro/backend/internal/db"
	"amiro/backend/internal/db/models"
)

func TestChatExportRepository_ExportChatSnapshotsThreadAndMessages(t *testing.T) {
	chatRepo, gdb, u := newTestChatRepo(t)
	exportRepo := NewChatExportRepository(gdb, chatRepo)
	ctx := context.Background()

	if err := chatRepo.InsertThread(ctx, &models.ChatThread{ID: "thread-1", Title: "My Thread", UserID: u.ID}); err != nil {
		t.Fatalf("InsertThread: %v", err)
	}
	if err := chatRepo.UpsertMessage(ctx, &models.ChatMessage{
		ID: "msg-1", ThreadID: "thread-1", Role: "user",
		Parts: datatypes.JSON(`[{"type":"text","text":"hi"}]`),
	}); err != nil {
		t.Fatalf("UpsertMessage: %v", err)
	}

	exportID, err := exportRepo.ExportChat(ctx, "thread-1", u.ID, nil)
	if err != nil {
		t.Fatalf("ExportChat: %v", err)
	}
	if exportID == "" {
		t.Fatal("expected a non-empty export id")
	}

	var export models.ChatExport
	if err := gdb.Where("id = ?", exportID).First(&export).Error; err != nil {
		t.Fatalf("load export: %v", err)
	}
	if export.Title != "My Thread" {
		t.Fatalf("title = %q, want %q", export.Title, "My Thread")
	}
	if export.ExporterID != u.ID {
		t.Fatalf("exporterID = %q, want %q", export.ExporterID, u.ID)
	}
	if export.OriginalThreadID == nil || *export.OriginalThreadID != "thread-1" {
		t.Fatalf("originalThreadID = %v, want thread-1", export.OriginalThreadID)
	}

	var snapshot []map[string]any
	if err := json.Unmarshal(export.Messages, &snapshot); err != nil {
		t.Fatalf("unmarshal snapshot: %v", err)
	}
	if len(snapshot) != 1 || snapshot[0]["id"] != "msg-1" {
		t.Fatalf("snapshot = %+v", snapshot)
	}
}

func TestChatExportRepository_ExportChatFailsForMissingThread(t *testing.T) {
	chatRepo, gdb, u := newTestChatRepo(t)
	exportRepo := NewChatExportRepository(gdb, chatRepo)

	_, err := exportRepo.ExportChat(context.Background(), "does-not-exist", u.ID, nil)
	if err == nil {
		t.Fatal("expected an error exporting a nonexistent thread")
	}
}

func TestChatExportRepository_ExportChatDefaultsExporterToThreadOwnerWhenEmpty(t *testing.T) {
	chatRepo, gdb, u := newTestChatRepo(t)
	exportRepo := NewChatExportRepository(gdb, chatRepo)
	ctx := context.Background()
	_ = chatRepo.InsertThread(ctx, &models.ChatThread{ID: "thread-1", UserID: u.ID})

	exportID, err := exportRepo.ExportChat(ctx, "thread-1", "", nil)
	if err != nil {
		t.Fatalf("ExportChat: %v", err)
	}

	var export models.ChatExport
	if err := gdb.Where("id = ?", exportID).First(&export).Error; err != nil {
		t.Fatalf("load export: %v", err)
	}
	if export.ExporterID != u.ID {
		t.Fatalf("exporterID = %q, want the thread owner %q", export.ExporterID, u.ID)
	}
}

func newExportTestEnv(t *testing.T) (*ChatExportRepository, *ChatRepository, *gorm.DB, *models.User, *models.User) {
	t.Helper()
	dsn := filepath.Join(t.TempDir(), "test.db")
	gdb, err := db.Open(db.DialectSQLite, dsn)
	if err != nil {
		t.Fatalf("db.Open: %v", err)
	}
	exporter := &models.User{Name: "Ada", Email: "ada@example.com"}
	reader := &models.User{Name: "Grace", Email: "grace@example.com"}
	for _, u := range []*models.User{exporter, reader} {
		if err := gdb.Create(u).Error; err != nil {
			t.Fatalf("create user: %v", err)
		}
	}
	chats := NewChatRepository(gdb)
	return NewChatExportRepository(gdb, chats), chats, gdb, exporter, reader
}

func seedExport(t *testing.T, gdb *gorm.DB, exporterID, title string, expiresAt *time.Time) *models.ChatExport {
	t.Helper()
	export := &models.ChatExport{
		Title:      title,
		ExporterID: exporterID,
		Messages:   datatypes.JSON(`[{"id":"m1","role":"user","parts":[]}]`),
		ExpiresAt:  expiresAt,
	}
	if err := gdb.Create(export).Error; err != nil {
		t.Fatalf("create export: %v", err)
	}
	return export
}

func TestChatExportRepository_SelectSummaryCountsCommentsAndOmitsMessages(t *testing.T) {
	repo, _, gdb, exporter, reader := newExportTestEnv(t)
	ctx := context.Background()
	withComments := seedExport(t, gdb, exporter.ID, "Discussed", nil)
	seedExport(t, gdb, exporter.ID, "Untouched", nil)

	for i := 0; i < 2; i++ {
		comment := &models.ChatExportComment{
			ExportID: withComments.ID, AuthorID: reader.ID,
			Content: datatypes.JSON(`{"type":"doc"}`),
		}
		if err := repo.InsertComment(ctx, comment); err != nil {
			t.Fatalf("InsertComment: %v", err)
		}
	}

	rows, err := repo.SelectSummaryByExporterID(ctx, exporter.ID)
	if err != nil {
		t.Fatalf("SelectSummaryByExporterID: %v", err)
	}

	counts := map[string]int64{}
	for _, row := range rows {
		counts[row.ChatExport.Title] = row.CommentCount
		if len(row.ChatExport.Messages) != 0 {
			t.Fatalf("summary carried the messages blob for %q", row.ChatExport.Title)
		}
	}
	if counts["Discussed"] != 2 {
		t.Fatalf("comment count = %d, want 2", counts["Discussed"])
	}
	if _, ok := counts["Untouched"]; !ok || counts["Untouched"] != 0 {
		t.Fatalf("an export with no comments was dropped or miscounted: %v", counts)
	}
}

func TestChatExportRepository_SelectSummaryExcludesOtherExporters(t *testing.T) {
	repo, _, gdb, exporter, reader := newExportTestEnv(t)
	seedExport(t, gdb, reader.ID, "Theirs", nil)

	rows, err := repo.SelectSummaryByExporterID(context.Background(), exporter.ID)
	if err != nil {
		t.Fatalf("SelectSummaryByExporterID: %v", err)
	}
	if len(rows) != 0 {
		t.Fatalf("got %d rows, want 0", len(rows))
	}
}

func TestChatExportRepository_SelectByIDWithUserJoinsTheExporter(t *testing.T) {
	repo, _, gdb, exporter, _ := newExportTestEnv(t)
	export := seedExport(t, gdb, exporter.ID, "Shared", nil)

	got, err := repo.SelectByIDWithUser(context.Background(), export.ID)
	if err != nil {
		t.Fatalf("SelectByIDWithUser: %v", err)
	}
	if got == nil || got.ExporterName == nil || *got.ExporterName != "Ada" {
		t.Fatalf("got %+v", got)
	}
}

func TestChatExportRepository_SelectByIDWithUserReturnsNilForMissingID(t *testing.T) {
	repo, _, _, _, _ := newExportTestEnv(t)

	got, err := repo.SelectByIDWithUser(context.Background(), "no-such-id")
	if err != nil {
		t.Fatalf("SelectByIDWithUser: %v", err)
	}
	if got != nil {
		t.Fatalf("got %+v, want nil", got)
	}
}

func TestChatExportRepository_CheckAccessIsExporterOnly(t *testing.T) {
	repo, _, gdb, exporter, reader := newExportTestEnv(t)
	ctx := context.Background()
	export := seedExport(t, gdb, exporter.ID, "Shared", nil)

	if ok, _ := repo.CheckAccess(ctx, export.ID, exporter.ID); !ok {
		t.Fatal("exporter denied access to their own export")
	}
	if ok, _ := repo.CheckAccess(ctx, export.ID, reader.ID); ok {
		t.Fatal("a non-exporter was granted delete access")
	}
}

func TestChatExportRepository_IsExpired(t *testing.T) {
	repo, _, gdb, exporter, _ := newExportTestEnv(t)
	ctx := context.Background()
	past := time.Now().Add(-time.Hour)
	future := time.Now().Add(time.Hour)

	expired := seedExport(t, gdb, exporter.ID, "Expired", &past)
	live := seedExport(t, gdb, exporter.ID, "Live", &future)
	forever := seedExport(t, gdb, exporter.ID, "Forever", nil)

	for _, tc := range []struct {
		id   string
		want bool
	}{{expired.ID, true}, {live.ID, false}, {forever.ID, false}, {"no-such-id", false}} {
		got, err := repo.IsExpired(ctx, tc.id)
		if err != nil {
			t.Fatalf("IsExpired(%s): %v", tc.id, err)
		}
		if got != tc.want {
			t.Fatalf("IsExpired(%s) = %v, want %v", tc.id, got, tc.want)
		}
	}
}

func TestChatExportRepository_DeleteByIDCascadesToComments(t *testing.T) {
	repo, _, gdb, exporter, reader := newExportTestEnv(t)
	ctx := context.Background()
	export := seedExport(t, gdb, exporter.ID, "Shared", nil)
	_ = repo.InsertComment(ctx, &models.ChatExportComment{
		ExportID: export.ID, AuthorID: reader.ID, Content: datatypes.JSON(`{"type":"doc"}`),
	})

	if err := repo.DeleteByID(ctx, export.ID); err != nil {
		t.Fatalf("DeleteByID: %v", err)
	}

	var orphans int64
	if err := gdb.Model(&models.ChatExportComment{}).Where("export_id = ?", export.ID).Count(&orphans).Error; err != nil {
		t.Fatalf("count comments: %v", err)
	}
	if orphans != 0 {
		t.Fatalf("%d comments outlived their export -- ON DELETE CASCADE did not fire", orphans)
	}
}

func TestChatExportRepository_SelectCommentsNestsRepliesUnderTheirParent(t *testing.T) {
	repo, _, gdb, exporter, reader := newExportTestEnv(t)
	ctx := context.Background()
	export := seedExport(t, gdb, exporter.ID, "Shared", nil)

	parent := &models.ChatExportComment{ExportID: export.ID, AuthorID: exporter.ID, Content: datatypes.JSON(`{"n":1}`)}
	if err := repo.InsertComment(ctx, parent); err != nil {
		t.Fatalf("InsertComment: %v", err)
	}
	reply := &models.ChatExportComment{ExportID: export.ID, AuthorID: reader.ID, ParentID: &parent.ID, Content: datatypes.JSON(`{"n":2}`)}
	if err := repo.InsertComment(ctx, reply); err != nil {
		t.Fatalf("InsertComment: %v", err)
	}

	comments, err := repo.SelectCommentsByExportID(ctx, export.ID, "")
	if err != nil {
		t.Fatalf("SelectCommentsByExportID: %v", err)
	}
	// Only top-level comments come back; the reply lives inside its parent.
	if len(comments) != 1 {
		t.Fatalf("got %d top-level comments, want 1", len(comments))
	}
	if len(comments[0].Replies) != 1 || comments[0].Replies[0].ID != reply.ID {
		t.Fatalf("reply was not nested under its parent: %+v", comments[0])
	}
}

func TestChatExportRepository_SelectCommentsMarksTheCallersOwnComments(t *testing.T) {
	repo, _, gdb, exporter, reader := newExportTestEnv(t)
	ctx := context.Background()
	export := seedExport(t, gdb, exporter.ID, "Shared", nil)
	_ = repo.InsertComment(ctx, &models.ChatExportComment{ExportID: export.ID, AuthorID: exporter.ID, Content: datatypes.JSON(`{}`)})

	owned, err := repo.SelectCommentsByExportID(ctx, export.ID, exporter.ID)
	if err != nil {
		t.Fatalf("SelectCommentsByExportID: %v", err)
	}
	if !owned[0].IsOwner {
		t.Fatal("isOwner = false for the comment's own author")
	}

	foreign, _ := repo.SelectCommentsByExportID(ctx, export.ID, reader.ID)
	if foreign[0].IsOwner {
		t.Fatal("isOwner = true for someone else's comment")
	}

	// The anonymous (no session) read never claims ownership.
	anonymous, _ := repo.SelectCommentsByExportID(ctx, export.ID, "")
	if anonymous[0].IsOwner {
		t.Fatal("isOwner = true on an unauthenticated read")
	}
}

func TestChatExportRepository_DeleteCommentIsAuthorOnly(t *testing.T) {
	repo, _, gdb, exporter, reader := newExportTestEnv(t)
	ctx := context.Background()
	export := seedExport(t, gdb, exporter.ID, "Shared", nil)
	comment := &models.ChatExportComment{ExportID: export.ID, AuthorID: reader.ID, Content: datatypes.JSON(`{}`)}
	_ = repo.InsertComment(ctx, comment)

	if ok, _ := repo.CheckCommentAccess(ctx, comment.ID, exporter.ID); ok {
		t.Fatal("the export's owner was granted delete access to someone else's comment")
	}
	if err := repo.DeleteComment(ctx, comment.ID, exporter.ID); err != nil {
		t.Fatalf("DeleteComment: %v", err)
	}
	if comments, _ := repo.SelectCommentsByExportID(ctx, export.ID, ""); len(comments) != 1 {
		t.Fatal("a non-author deleted the comment")
	}

	if err := repo.DeleteComment(ctx, comment.ID, reader.ID); err != nil {
		t.Fatalf("DeleteComment: %v", err)
	}
	if comments, _ := repo.SelectCommentsByExportID(ctx, export.ID, ""); len(comments) != 0 {
		t.Fatal("the author's own delete did not remove the comment")
	}
}

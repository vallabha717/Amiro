package checkpoint_test

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"

	"gorm.io/gorm"

	agentcheckpoint "amiro/backend/internal/agent/checkpoint"
	"amiro/backend/internal/agent/permission"
	"amiro/backend/internal/agent/workspace"
	checkpointapi "amiro/backend/internal/api/checkpoint"
	"amiro/backend/internal/auth"
	"amiro/backend/internal/db"
	"amiro/backend/internal/db/models"
	"amiro/backend/internal/db/repository"
	"amiro/backend/internal/storage"
)

type testEnv struct {
	h      *checkpointapi.Handler
	repo   *repository.CheckpointFileRepository
	blobs  storage.Storage
	gdb    *gorm.DB
	owner  *models.User
	other  *models.User
	thread *models.ChatThread
	ws     *workspace.Workspace
	grants *permission.Store
}

func newTestEnv(t *testing.T) testEnv {
	t.Helper()
	gdb, err := db.Open(db.DialectSQLite, filepath.Join(t.TempDir(), "test.db"))
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
	thread := &models.ChatThread{ID: models.NewID(), UserID: owner.ID, Title: "t"}
	if err := gdb.Create(thread).Error; err != nil {
		t.Fatalf("create thread: %v", err)
	}
	chats := repository.NewChatRepository(gdb)
	repo := repository.NewCheckpointFileRepository(gdb)
	blobs, err := storage.NewLocalStorage(t.TempDir(), []byte("secret"), "http://127.0.0.1:0")
	if err != nil {
		t.Fatalf("NewLocalStorage: %v", err)
	}
	ws, err := workspace.New(t.TempDir())
	if err != nil {
		t.Fatalf("workspace.New: %v", err)
	}
	grants := permission.NewStore()

	return testEnv{
		h:      checkpointapi.NewHandler(repo, blobs, chats, grants),
		repo:   repo,
		blobs:  blobs,
		gdb:    gdb,
		owner:  owner,
		other:  other,
		thread: thread,
		ws:     ws,
		grants: grants,
	}
}

func authedContext(u *models.User) context.Context {
	return auth.ContextWithUser(context.Background(), u)
}

func TestHandler_Files_Unauthorized(t *testing.T) {
	env := newTestEnv(t)
	req := httptest.NewRequest(http.MethodGet, "/api/checkpoint/files?threadId=x&turnId=y", nil)
	rec := httptest.NewRecorder()

	env.h.Files(rec, req)
	if rec.Code != http.StatusUnauthorized {
		t.Errorf("status = %d, want 401", rec.Code)
	}
}

func TestHandler_Files_MissingParamsIsBadRequest(t *testing.T) {
	env := newTestEnv(t)
	req := httptest.NewRequest(http.MethodGet, "/api/checkpoint/files", nil).WithContext(authedContext(env.owner))
	rec := httptest.NewRecorder()

	env.h.Files(rec, req)
	if rec.Code != http.StatusBadRequest {
		t.Errorf("status = %d, want 400", rec.Code)
	}
}

func TestHandler_Files_OtherUsersThreadIsForbidden(t *testing.T) {
	env := newTestEnv(t)
	req := httptest.NewRequest(http.MethodGet, "/api/checkpoint/files?threadId="+env.thread.ID+"&turnId=t1", nil).
		WithContext(authedContext(env.other))
	rec := httptest.NewRecorder()

	env.h.Files(rec, req)
	if rec.Code != http.StatusForbidden {
		t.Errorf("status = %d, want 403", rec.Code)
	}
}

func TestHandler_Latest_NoCheckpointsReportsEmptyNotFound(t *testing.T) {
	env := newTestEnv(t)
	req := httptest.NewRequest(http.MethodGet, "/api/checkpoint/latest?threadId="+env.thread.ID, nil).
		WithContext(authedContext(env.owner))
	rec := httptest.NewRecorder()

	env.h.Latest(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200 (empty is a valid, not-found-shaped 200)", rec.Code)
	}
	var resp struct {
		TurnID string `json:"turnId"`
		Files  []any  `json:"files"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &resp); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if resp.TurnID != "" || len(resp.Files) != 0 {
		t.Errorf("resp = %+v, want empty", resp)
	}
}

func TestHandler_FilesThenRestoreRoundTrips(t *testing.T) {
	env := newTestEnv(t)

	writeAbs := filepath.Join(env.ws.Root(), "a.txt")
	if err := os.WriteFile(writeAbs, []byte("original"), 0o644); err != nil {
		t.Fatalf("seed file: %v", err)
	}

	cap := agentcheckpoint.NewCapturer(env.repo, env.blobs, env.ws, env.thread.ID, "turn-1")
	cap.Capture(context.Background(), "a.txt")
	if err := os.WriteFile(writeAbs, []byte("edited by the turn"), 0o644); err != nil {
		t.Fatalf("simulate turn write: %v", err)
	}

	filesReq := httptest.NewRequest(http.MethodGet, "/api/checkpoint/files?threadId="+env.thread.ID+"&turnId=turn-1", nil).
		WithContext(authedContext(env.owner))
	filesRec := httptest.NewRecorder()
	env.h.Files(filesRec, filesReq)
	if filesRec.Code != http.StatusOK {
		t.Fatalf("Files: code = %d, body = %s", filesRec.Code, filesRec.Body)
	}
	var filesResp struct {
		TurnID string `json:"turnId"`
		Files  []struct {
			Path          string `json:"path"`
			ExistedBefore bool   `json:"existedBefore"`
		} `json:"files"`
	}
	if err := json.Unmarshal(filesRec.Body.Bytes(), &filesResp); err != nil {
		t.Fatalf("decode files: %v", err)
	}
	if len(filesResp.Files) != 1 || filesResp.Files[0].Path != "a.txt" || !filesResp.Files[0].ExistedBefore {
		t.Fatalf("files = %+v, want exactly one existed-before a.txt", filesResp.Files)
	}

	restoreBody, _ := json.Marshal(map[string]string{"threadId": env.thread.ID, "turnId": "turn-1"})
	restoreReq := httptest.NewRequest(http.MethodPost, "/api/checkpoint/restore", bytes.NewReader(restoreBody)).
		WithContext(authedContext(env.owner))
	restoreRec := httptest.NewRecorder()
	env.h.Restore(restoreRec, restoreReq)
	if restoreRec.Code != http.StatusOK {
		t.Fatalf("Restore: code = %d, body = %s", restoreRec.Code, restoreRec.Body)
	}
	var restoreResp struct {
		Files []struct {
			Path     string `json:"path"`
			Restored bool   `json:"restored"`
		} `json:"files"`
	}
	if err := json.Unmarshal(restoreRec.Body.Bytes(), &restoreResp); err != nil {
		t.Fatalf("decode restore: %v", err)
	}
	if len(restoreResp.Files) != 1 || !restoreResp.Files[0].Restored {
		t.Fatalf("restore result = %+v, want one restored file", restoreResp.Files)
	}

	got, err := os.ReadFile(writeAbs)
	if err != nil {
		t.Fatalf("read restored file: %v", err)
	}
	if string(got) != "original" {
		t.Errorf("restored content = %q, want %q", got, "original")
	}
}

func TestHandler_Restore_OtherUsersThreadIsForbidden(t *testing.T) {
	env := newTestEnv(t)
	body, _ := json.Marshal(map[string]string{"threadId": env.thread.ID, "turnId": "turn-1"})
	req := httptest.NewRequest(http.MethodPost, "/api/checkpoint/restore", bytes.NewReader(body)).
		WithContext(authedContext(env.other))
	rec := httptest.NewRecorder()

	env.h.Restore(rec, req)
	if rec.Code != http.StatusForbidden {
		t.Errorf("status = %d, want 403", rec.Code)
	}
}

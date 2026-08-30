package workspacetrust_test

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"testing"

	"gorm.io/gorm"

	workspacetrustapi "amiro/backend/internal/api/workspacetrust"
	"amiro/backend/internal/auth"
	"amiro/backend/internal/db"
	"amiro/backend/internal/db/models"
	"amiro/backend/internal/db/repository"
)

func newTestHandler(t *testing.T) (*workspacetrustapi.Handler, *gorm.DB, *models.User) {
	t.Helper()
	gdb, err := db.Open(db.DialectSQLite, filepath.Join(t.TempDir(), "test.db"))
	if err != nil {
		t.Fatalf("db.Open: %v", err)
	}
	u := &models.User{Name: "Ada", Email: "ada@example.com"}
	if err := gdb.Create(u).Error; err != nil {
		t.Fatalf("create user: %v", err)
	}
	repo := repository.NewWorkspaceTrustRepository(gdb)
	return workspacetrustapi.NewHandler(repo, ""), gdb, u
}

func authedContext(u *models.User) context.Context {
	return auth.ContextWithUser(context.Background(), u)
}

func TestHandler_Status_Unauthorized(t *testing.T) {
	h, _, _ := newTestHandler(t)
	req := httptest.NewRequest(http.MethodGet, "/api/workspace-trust/status?root=/tmp", nil)
	rec := httptest.NewRecorder()

	h.Status(rec, req)
	if rec.Code != http.StatusUnauthorized {
		t.Errorf("status = %d, want 401", rec.Code)
	}
}

func TestHandler_Status_MissingRootIsBadRequest(t *testing.T) {
	h, _, u := newTestHandler(t)
	req := httptest.NewRequest(http.MethodGet, "/api/workspace-trust/status", nil).WithContext(authedContext(u))
	rec := httptest.NewRecorder()

	h.Status(rec, req)
	if rec.Code != http.StatusBadRequest {
		t.Errorf("status = %d, want 400", rec.Code)
	}
}

func TestHandler_Status_UnreachableRootIsBadRequest(t *testing.T) {
	h, _, u := newTestHandler(t)
	req := httptest.NewRequest(http.MethodGet, "/api/workspace-trust/status?root=/no/such/directory/anywhere", nil).WithContext(authedContext(u))
	rec := httptest.NewRecorder()

	h.Status(rec, req)
	if rec.Code != http.StatusBadRequest {
		t.Errorf("status = %d, want 400", rec.Code)
	}
}

func TestHandler_StatusThenGrantThenStatusRoundTrips(t *testing.T) {
	h, _, u := newTestHandler(t)
	root := t.TempDir()

	statusReq := httptest.NewRequest(http.MethodGet, "/api/workspace-trust/status?root="+root, nil).WithContext(authedContext(u))
	statusRec := httptest.NewRecorder()
	h.Status(statusRec, statusReq)
	if statusRec.Code != http.StatusOK {
		t.Fatalf("status before grant: code = %d, body = %s", statusRec.Code, statusRec.Body)
	}
	var before struct {
		Trusted      bool   `json:"trusted"`
		ResolvedRoot string `json:"resolvedRoot"`
	}
	if err := json.Unmarshal(statusRec.Body.Bytes(), &before); err != nil {
		t.Fatalf("decode status: %v", err)
	}
	if before.Trusted {
		t.Fatal("Trusted = true before any grant")
	}

	grantBody, _ := json.Marshal(map[string]string{"root": root})
	grantReq := httptest.NewRequest(http.MethodPost, "/api/workspace-trust/grant", bytes.NewReader(grantBody)).WithContext(authedContext(u))
	grantRec := httptest.NewRecorder()
	h.Grant(grantRec, grantReq)
	if grantRec.Code != http.StatusOK {
		t.Fatalf("grant: code = %d, body = %s", grantRec.Code, grantRec.Body)
	}

	statusReq2 := httptest.NewRequest(http.MethodGet, "/api/workspace-trust/status?root="+root, nil).WithContext(authedContext(u))
	statusRec2 := httptest.NewRecorder()
	h.Status(statusRec2, statusReq2)
	var after struct {
		Trusted bool `json:"trusted"`
	}
	if err := json.Unmarshal(statusRec2.Body.Bytes(), &after); err != nil {
		t.Fatalf("decode status: %v", err)
	}
	if !after.Trusted {
		t.Fatal("Trusted = false after Grant")
	}

	listReq := httptest.NewRequest(http.MethodGet, "/api/workspace-trust", nil).WithContext(authedContext(u))
	listRec := httptest.NewRecorder()
	h.List(listRec, listReq)
	var list struct {
		Grants []struct {
			ResolvedRoot string `json:"resolvedRoot"`
			GrantedVia   string `json:"grantedVia"`
		} `json:"grants"`
	}
	if err := json.Unmarshal(listRec.Body.Bytes(), &list); err != nil {
		t.Fatalf("decode list: %v", err)
	}
	if len(list.Grants) != 1 || list.Grants[0].GrantedVia != repository.GrantedViaPrompt {
		t.Fatalf("grants = %+v, want exactly one prompt-granted root", list.Grants)
	}

	revokeBody, _ := json.Marshal(map[string]string{"root": root})
	revokeReq := httptest.NewRequest(http.MethodPost, "/api/workspace-trust/revoke", bytes.NewReader(revokeBody)).WithContext(authedContext(u))
	revokeRec := httptest.NewRecorder()
	h.Revoke(revokeRec, revokeReq)
	if revokeRec.Code != http.StatusOK {
		t.Fatalf("revoke: code = %d, body = %s", revokeRec.Code, revokeRec.Body)
	}

	statusReq3 := httptest.NewRequest(http.MethodGet, "/api/workspace-trust/status?root="+root, nil).WithContext(authedContext(u))
	statusRec3 := httptest.NewRecorder()
	h.Status(statusRec3, statusReq3)
	var afterRevoke struct {
		Trusted bool `json:"trusted"`
	}
	if err := json.Unmarshal(statusRec3.Body.Bytes(), &afterRevoke); err != nil {
		t.Fatalf("decode status: %v", err)
	}
	if afterRevoke.Trusted {
		t.Fatal("Trusted = true after Revoke")
	}
}

func TestHandler_Grant_MissingRootIsBadRequest(t *testing.T) {
	h, _, u := newTestHandler(t)
	body, _ := json.Marshal(map[string]string{"root": ""})
	req := httptest.NewRequest(http.MethodPost, "/api/workspace-trust/grant", bytes.NewReader(body)).WithContext(authedContext(u))
	rec := httptest.NewRecorder()

	h.Grant(rec, req)
	if rec.Code != http.StatusBadRequest {
		t.Errorf("status = %d, want 400", rec.Code)
	}
}

func TestHandler_Revoke_Unauthorized(t *testing.T) {
	h, _, _ := newTestHandler(t)
	body, _ := json.Marshal(map[string]string{"root": "/tmp"})
	req := httptest.NewRequest(http.MethodPost, "/api/workspace-trust/revoke", bytes.NewReader(body))
	rec := httptest.NewRecorder()

	h.Revoke(rec, req)
	if rec.Code != http.StatusUnauthorized {
		t.Errorf("status = %d, want 401", rec.Code)
	}
}

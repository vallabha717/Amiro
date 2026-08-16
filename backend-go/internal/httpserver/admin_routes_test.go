package httpserver

import (
	"bytes"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"testing"

	adminapi "amiro/backend/internal/api/admin"
	"amiro/backend/internal/auth"
	"amiro/backend/internal/db"
	"amiro/backend/internal/db/models"
	"amiro/backend/internal/db/repository"
	"amiro/backend/internal/middleware"

	"gorm.io/gorm"
)

type adminTestEnv struct {
	handler   http.Handler
	db        *gorm.DB
	userRepo  *repository.UserRepository
	adminID   string
	adminTok  string
	memberID  string
	memberTok string
}

// newAdminTestEnv registers two real users through the actual HTTP routes
// (so tokens are genuine session tokens), then promotes one to admin
// directly in the DB -- there's no bootstrapping route for "the first
// admin" in this backend (same as better-auth, which expects that to be
// done out-of-band), so tests do the same thing an operator would.
func newAdminTestEnv(t *testing.T) adminTestEnv {
	t.Helper()
	dsn := filepath.Join(t.TempDir(), "test.db")
	gdb, err := db.Open(db.DialectSQLite, dsn)
	if err != nil {
		t.Fatalf("db.Open: %v", err)
	}
	authService := auth.NewService(gdb)
	userRepo := repository.NewUserRepository(gdb)
	adminHandler := adminapi.NewHandler(userRepo)
	handler := New(testConfig(), Handlers{Auth: authService, Admin: adminHandler})

	env := adminTestEnv{handler: handler, db: gdb, userRepo: userRepo}

	adminID, adminTok := env.register(t, "Ada Admin", "ada@example.com", "hunter22")
	memberID, memberTok := env.register(t, "Mel Member", "mel@example.com", "hunter22")
	env.adminID, env.adminTok = adminID, adminTok
	env.memberID, env.memberTok = memberID, memberTok

	if err := gdb.Model(&models.User{}).Where("id = ?", adminID).Update("role", "admin").Error; err != nil {
		t.Fatalf("promote admin: %v", err)
	}
	return env
}

func (e adminTestEnv) register(t *testing.T, name, email, password string) (id, token string) {
	t.Helper()
	rec := e.do(t, http.MethodPost, "/api/auth/register", map[string]string{"name": name, "email": email, "password": password}, "")
	if rec.Code != http.StatusCreated {
		t.Fatalf("register status = %d, body = %s", rec.Code, rec.Body.String())
	}
	var resp struct {
		User  struct{ ID string } `json:"user"`
		Token string              `json:"token"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &resp); err != nil {
		t.Fatalf("unmarshal register response: %v", err)
	}
	return resp.User.ID, resp.Token
}

func (e adminTestEnv) do(t *testing.T, method, path string, body any, bearer string) *httptest.ResponseRecorder {
	t.Helper()
	var reader *bytes.Reader
	if body != nil {
		b, err := json.Marshal(body)
		if err != nil {
			t.Fatalf("marshal: %v", err)
		}
		reader = bytes.NewReader(b)
	} else {
		reader = bytes.NewReader(nil)
	}
	req := httptest.NewRequest(method, path, reader)
	req.Header.Set(middleware.AuthHeader, "test-token")
	if bearer != "" {
		req.Header.Set("Authorization", "Bearer "+bearer)
	}
	rec := httptest.NewRecorder()
	e.handler.ServeHTTP(rec, req)
	return rec
}

func TestAdminRoutes_NonAdminGetsForbidden(t *testing.T) {
	env := newAdminTestEnv(t)
	rec := env.do(t, http.MethodGet, "/api/admin/users", nil, env.memberTok)
	if rec.Code != http.StatusForbidden {
		t.Fatalf("status = %d, want 403, body = %s", rec.Code, rec.Body.String())
	}
}

func TestAdminRoutes_ListReturnsBothUsersWithoutPasswords(t *testing.T) {
	env := newAdminTestEnv(t)
	rec := env.do(t, http.MethodGet, "/api/admin/users", nil, env.adminTok)
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, body = %s", rec.Code, rec.Body.String())
	}
	var resp struct {
		Users []map[string]any `json:"users"`
		Total int              `json:"total"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &resp); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	if resp.Total != 2 || len(resp.Users) != 2 {
		t.Fatalf("got %+v, want both registered users", resp)
	}
	for _, u := range resp.Users {
		if _, hasPassword := u["password"]; hasPassword {
			t.Fatalf("password leaked into admin list response: %+v", u)
		}
	}
}

func TestAdminRoutes_ListSearchFiltersByNameOrEmail(t *testing.T) {
	env := newAdminTestEnv(t)
	rec := env.do(t, http.MethodGet, "/api/admin/users?q=mel", nil, env.adminTok)
	var resp struct {
		Users []map[string]any `json:"users"`
		Total int              `json:"total"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &resp); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	if resp.Total != 1 || resp.Users[0]["name"] != "Mel Member" {
		t.Fatalf("got %+v, want only Mel Member", resp)
	}
}

func TestAdminRoutes_UpdateRole(t *testing.T) {
	env := newAdminTestEnv(t)
	rec := env.do(t, http.MethodPut, "/api/admin/users/"+env.memberID+"/role", map[string]string{"role": "admin"}, env.adminTok)
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, body = %s", rec.Code, rec.Body.String())
	}
	get := env.do(t, http.MethodGet, "/api/admin/users/"+env.memberID, nil, env.adminTok)
	var detail map[string]any
	if err := json.Unmarshal(get.Body.Bytes(), &detail); err != nil {
		t.Fatal(err)
	}
	if detail["role"] != "admin" {
		t.Fatalf("role = %v, want admin", detail["role"])
	}
}

func TestAdminRoutes_UpdateRole_RejectsSelf(t *testing.T) {
	env := newAdminTestEnv(t)
	rec := env.do(t, http.MethodPut, "/api/admin/users/"+env.adminID+"/role", map[string]string{"role": "user"}, env.adminTok)
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("status = %d, want 400 for a self role change, body = %s", rec.Code, rec.Body.String())
	}
}

func TestAdminRoutes_UpdateRole_RejectsInvalidRole(t *testing.T) {
	env := newAdminTestEnv(t)
	rec := env.do(t, http.MethodPut, "/api/admin/users/"+env.memberID+"/role", map[string]string{"role": "superuser"}, env.adminTok)
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("status = %d, want 400 for an invalid role, body = %s", rec.Code, rec.Body.String())
	}
}

func TestAdminRoutes_BanThenLoginIsBlocked(t *testing.T) {
	env := newAdminTestEnv(t)
	ban := env.do(t, http.MethodPut, "/api/admin/users/"+env.memberID+"/ban", map[string]any{"banned": true, "banReason": "spam"}, env.adminTok)
	if ban.Code != http.StatusOK {
		t.Fatalf("ban status = %d, body = %s", ban.Code, ban.Body.String())
	}

	login := env.do(t, http.MethodPost, "/api/auth/login", map[string]string{"email": "mel@example.com", "password": "hunter22"}, "")
	if login.Code != http.StatusForbidden {
		t.Fatalf("login status after ban = %d, want 403, body = %s", login.Code, login.Body.String())
	}

	unban := env.do(t, http.MethodPut, "/api/admin/users/"+env.memberID+"/ban", map[string]any{"banned": false}, env.adminTok)
	if unban.Code != http.StatusOK {
		t.Fatalf("unban status = %d, body = %s", unban.Code, unban.Body.String())
	}
	loginAgain := env.do(t, http.MethodPost, "/api/auth/login", map[string]string{"email": "mel@example.com", "password": "hunter22"}, "")
	if loginAgain.Code != http.StatusOK {
		t.Fatalf("login status after unban = %d, want 200, body = %s", loginAgain.Code, loginAgain.Body.String())
	}
}

func TestAdminRoutes_UpdateBanStatus_RejectsSelf(t *testing.T) {
	env := newAdminTestEnv(t)
	rec := env.do(t, http.MethodPut, "/api/admin/users/"+env.adminID+"/ban", map[string]any{"banned": true}, env.adminTok)
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("status = %d, want 400 for self-ban, body = %s", rec.Code, rec.Body.String())
	}
}

func TestAdminRoutes_DeleteUser(t *testing.T) {
	env := newAdminTestEnv(t)
	rec := env.do(t, http.MethodDelete, "/api/admin/users/"+env.memberID, nil, env.adminTok)
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, body = %s", rec.Code, rec.Body.String())
	}
	get := env.do(t, http.MethodGet, "/api/admin/users/"+env.memberID, nil, env.adminTok)
	if get.Code != http.StatusNotFound {
		t.Fatalf("status = %d, want 404 after delete, body = %s", get.Code, get.Body.String())
	}
}

func TestAdminRoutes_Delete_RejectsSelf(t *testing.T) {
	env := newAdminTestEnv(t)
	rec := env.do(t, http.MethodDelete, "/api/admin/users/"+env.adminID, nil, env.adminTok)
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("status = %d, want 400 for self-delete, body = %s", rec.Code, rec.Body.String())
	}
}

func TestAdminRoutes_GetStats(t *testing.T) {
	env := newAdminTestEnv(t)
	rec := env.do(t, http.MethodGet, "/api/admin/users/"+env.memberID+"/stats", nil, env.adminTok)
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, body = %s", rec.Code, rec.Body.String())
	}
	var resp struct {
		User  struct{ ID string } `json:"user"`
		Stats struct {
			ThreadCount int    `json:"threadCount"`
			TotalTokens int64  `json:"totalTokens"`
			Period      string `json:"period"`
		} `json:"stats"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &resp); err != nil {
		t.Fatalf("unmarshal stats response: %v", err)
	}
	if resp.User.ID != env.memberID {
		t.Errorf("expected user ID %s, got %s", env.memberID, resp.User.ID)
	}
	if resp.Stats.Period != "Last 30 Days" {
		t.Errorf("expected period 'Last 30 Days', got %s", resp.Stats.Period)
	}
}

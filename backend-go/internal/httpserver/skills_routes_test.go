package httpserver

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"testing"

	skillsapi "amiro/backend/internal/api/skills"
	"amiro/backend/internal/auth"
	"amiro/backend/internal/db"
	"amiro/backend/internal/skills"
)

type cannedSkillsService struct {
	listRes *skills.ListResult
	getRes  *skills.Skill
}

func (c *cannedSkillsService) List(ctx context.Context, home, project string) (*skills.ListResult, error) {
	if c.listRes != nil {
		return c.listRes, nil
	}
	return &skills.ListResult{
		Items: []skills.Skill{
			{
				Name:        "canned-skill",
				Description: "A canned skill for httpserver testing",
				Scope:       skills.ScopeProject,
				Source:      ".agents",
				Path:        "/proj/.agents/skills/canned-skill",
			},
		},
	}, nil
}

func (c *cannedSkillsService) Get(ctx context.Context, home, project, name string) (*skills.Skill, error) {
	if name == "canned-skill" {
		return &skills.Skill{
			Name:        "canned-skill",
			Description: "A canned skill for httpserver testing",
			Scope:       skills.ScopeProject,
			Source:      ".agents",
			Path:        "/proj/.agents/skills/canned-skill",
		}, nil
	}
	return nil, skills.ErrSkillNotFound
}

func TestSkillsRoutes(t *testing.T) {
	dir := t.TempDir()
	gdb, err := db.Open(db.DialectSQLite, filepath.Join(dir, "test.db"))
	if err != nil {
		t.Fatalf("db.Open: %v", err)
	}

	authService := auth.NewService(gdb)
	skillsHandler := skillsapi.NewHandler(&cannedSkillsService{})
	handler := New(testConfig(), Handlers{
		Auth:   authService,
		Skills: skillsHandler,
	})

	// Helper to send requests
	do := func(method, target string, body any, token string) *httptest.ResponseRecorder {
		var req *http.Request
		if body != nil {
			data, _ := json.Marshal(body)
			req = httptest.NewRequest(method, target, bytes.NewReader(data))
			req.Header.Set("Content-Type", "application/json")
		} else {
			req = httptest.NewRequest(method, target, nil)
		}
		if token != "" {
			req.Header.Set("Authorization", "Bearer "+token)
		}
		req.Header.Set("X-BetterChatbot-Token", "test-token")
		rec := httptest.NewRecorder()
		handler.ServeHTTP(rec, req)
		return rec
	}

	// Register and login to get session token
	regRec := do(http.MethodPost, "/api/auth/register", map[string]string{
		"name":     "Tester",
		"email":    "tester@example.com",
		"password": "hunter2password",
	}, "")
	if regRec.Code != http.StatusCreated {
		t.Fatalf("register status = %d: %s", regRec.Code, regRec.Body.String())
	}

	loginRec := do(http.MethodPost, "/api/auth/login", map[string]string{
		"email":    "tester@example.com",
		"password": "hunter2password",
	}, "")
	if loginRec.Code != http.StatusOK {
		t.Fatalf("login status = %d: %s", loginRec.Code, loginRec.Body.String())
	}
	var loginResp struct {
		Token string `json:"token"`
	}
	if err := json.Unmarshal(loginRec.Body.Bytes(), &loginResp); err != nil {
		t.Fatalf("unmarshal login: %v", err)
	}
	token := loginResp.Token

	// 1. GET /api/skills unauthorized
	unauthRec := do(http.MethodGet, "/api/skills", nil, "")
	if unauthRec.Code != http.StatusUnauthorized {
		t.Errorf("GET /api/skills without auth = %d, want 401", unauthRec.Code)
	}

	// 2. GET /api/skills with auth
	authRec := do(http.MethodGet, "/api/skills", nil, token)
	if authRec.Code != http.StatusOK {
		t.Fatalf("GET /api/skills with auth = %d, want 200: %s", authRec.Code, authRec.Body.String())
	}
	var listResp skillsapi.ListResponse
	if err := json.Unmarshal(authRec.Body.Bytes(), &listResp); err != nil {
		t.Fatalf("unmarshal list response: %v", err)
	}
	if len(listResp.Items) != 1 || listResp.Items[0].Name != "canned-skill" {
		t.Errorf("listResp = %+v", listResp)
	}

	// 3. GET /api/skills/items/canned-skill
	getRec := do(http.MethodGet, "/api/skills/items/canned-skill", nil, token)
	if getRec.Code != http.StatusOK {
		t.Fatalf("GET /api/skills/items/canned-skill = %d, want 200: %s", getRec.Code, getRec.Body.String())
	}

	// 4. GET /api/skills/items/nonexistent -> 404
	notFoundRec := do(http.MethodGet, "/api/skills/items/nonexistent", nil, token)
	if notFoundRec.Code != http.StatusNotFound {
		t.Errorf("GET /api/skills/items/nonexistent = %d, want 404", notFoundRec.Code)
	}
}

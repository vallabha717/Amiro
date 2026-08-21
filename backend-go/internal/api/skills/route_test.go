package skills_test

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"

	skillsapi "amiro/backend/internal/api/skills"
	"amiro/backend/internal/auth"
	"amiro/backend/internal/db/models"
	"amiro/backend/internal/skills"
)

type fakeService struct {
	listRes     *skills.ListResult
	listErr     error
	getRes      *skills.Skill
	getErr      error
	lastProject string
}

func (f *fakeService) List(ctx context.Context, home, project string) (*skills.ListResult, error) {
	f.lastProject = project
	return f.listRes, f.listErr
}

func (f *fakeService) Get(ctx context.Context, home, project, name string) (*skills.Skill, error) {
	f.lastProject = project
	return f.getRes, f.getErr
}

func (f *fakeService) Create(ctx context.Context, home string, in skills.WriteInput) (*skills.Skill, []skills.FieldError, error) {
	return nil, nil, nil
}

func (f *fakeService) Update(ctx context.Context, home, name string, in skills.WriteInput) (*skills.Skill, []skills.FieldError, error) {
	return nil, nil, nil
}

func (f *fakeService) Delete(ctx context.Context, home, name string, force bool) error {
	return nil
}

func (f *fakeService) Duplicate(ctx context.Context, home, name, project string) (*skills.Skill, error) {
	return nil, nil
}

func authedContext() context.Context {
	return auth.ContextWithUser(context.Background(), &models.User{
		ID:    "test-user-id",
		Email: "user@amiro.test",
	})
}

func TestHandler_List_Unauthorized(t *testing.T) {
	h := skillsapi.NewHandler(&fakeService{})
	req := httptest.NewRequest(http.MethodGet, "/api/skills", nil)
	rec := httptest.NewRecorder()

	h.List(rec, req)
	if rec.Code != http.StatusUnauthorized {
		t.Errorf("status = %d, want 401", rec.Code)
	}
}

func TestHandler_List_BadRequestNonAbsProject(t *testing.T) {
	h := skillsapi.NewHandler(&fakeService{})
	req := httptest.NewRequest(http.MethodGet, "/api/skills?project=relative/path", nil).WithContext(authedContext())
	rec := httptest.NewRecorder()

	h.List(rec, req)
	if rec.Code != http.StatusBadRequest {
		t.Errorf("status = %d, want 400", rec.Code)
	}
}

func TestHandler_List_BadRequestNonExistentProject(t *testing.T) {
	h := skillsapi.NewHandler(&fakeService{})
	req := httptest.NewRequest(http.MethodGet, "/api/skills?project=/nonexistent/path/for/sure", nil).WithContext(authedContext())
	rec := httptest.NewRecorder()

	h.List(rec, req)
	if rec.Code != http.StatusBadRequest {
		t.Errorf("status = %d, want 400", rec.Code)
	}
}

func TestHandler_List_BadRequestProjectIsFile(t *testing.T) {
	dir := t.TempDir()
	filePath := filepath.Join(dir, "somefile.txt")
	if err := os.WriteFile(filePath, []byte("hello"), 0o644); err != nil {
		t.Fatal(err)
	}

	h := skillsapi.NewHandler(&fakeService{})
	req := httptest.NewRequest(http.MethodGet, "/api/skills?project="+filePath, nil).WithContext(authedContext())
	rec := httptest.NewRecorder()

	h.List(rec, req)
	if rec.Code != http.StatusBadRequest {
		t.Errorf("status = %d, want 400 for file project path", rec.Code)
	}
}

func TestHandler_List_ResolvesSymlinkProject(t *testing.T) {
	dir := t.TempDir()
	targetDir := filepath.Join(dir, "target")
	if err := os.MkdirAll(targetDir, 0o755); err != nil {
		t.Fatal(err)
	}
	symlinkPath := filepath.Join(dir, "symlink")
	if err := os.Symlink(targetDir, symlinkPath); err != nil {
		t.Fatal(err)
	}

	svc := &fakeService{listRes: &skills.ListResult{}}
	h := skillsapi.NewHandler(svc)
	req := httptest.NewRequest(http.MethodGet, "/api/skills?project="+symlinkPath, nil).WithContext(authedContext())
	rec := httptest.NewRecorder()

	h.List(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200", rec.Code)
	}

	evalTarget, _ := filepath.EvalSymlinks(targetDir)
	if svc.lastProject != evalTarget {
		t.Errorf("svc.lastProject = %q, want resolved %q", svc.lastProject, evalTarget)
	}
}

func TestHandler_List_Success_OmitsBodyAndResources(t *testing.T) {
	svc := &fakeService{
		listRes: &skills.ListResult{
			Items: []skills.Skill{
				{
					Name:        "test-skill",
					Description: "A test skill",
					Scope:       skills.ScopeUser,
					Source:      ".agents",
					Path:        "/home/user/.agents/skills/test-skill",
					Writable:    true,
					Body:        "# Full markdown body instructions that should not be in list",
					Resources:   []string{"scripts/helper.sh"},
				},
			},
			Diagnostics: []skills.Diagnostic{
				{
					Path:     "/home/user/.claude/skills/broken/SKILL.md",
					Severity: "error",
					Message:  "missing description",
				},
			},
			Truncated: false,
		},
	}
	h := skillsapi.NewHandler(svc)
	req := httptest.NewRequest(http.MethodGet, "/api/skills", nil).WithContext(authedContext())
	rec := httptest.NewRecorder()

	h.List(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200", rec.Code)
	}

	// 1. Unmarshal into typed response
	var resp skillsapi.ListResponse
	if err := json.Unmarshal(rec.Body.Bytes(), &resp); err != nil {
		t.Fatalf("unmarshal response: %v", err)
	}
	if len(resp.Items) != 1 || resp.Items[0].Name != "test-skill" {
		t.Errorf("resp.Items = %+v", resp.Items)
	}

	// 2. Assert on raw JSON that "body" and "resources" fields do NOT exist
	var rawMap map[string]any
	if err := json.Unmarshal(rec.Body.Bytes(), &rawMap); err != nil {
		t.Fatalf("unmarshal raw JSON: %v", err)
	}
	itemsRaw, ok := rawMap["items"].([]any)
	if !ok || len(itemsRaw) != 1 {
		t.Fatalf("raw items = %+v", rawMap["items"])
	}
	firstItem := itemsRaw[0].(map[string]any)
	if _, hasBody := firstItem["body"]; hasBody {
		t.Errorf("raw list item JSON contains 'body', should be omitted: %+v", firstItem)
	}
	if _, hasResources := firstItem["resources"]; hasResources {
		t.Errorf("raw list item JSON contains 'resources', should be omitted: %+v", firstItem)
	}
}

func TestHandler_Get_NotFound(t *testing.T) {
	svc := &fakeService{
		getErr: skills.ErrSkillNotFound,
	}
	h := skillsapi.NewHandler(svc)
	req := httptest.NewRequest(http.MethodGet, "/api/skills/items/nonexistent", nil).WithContext(authedContext())
	req.SetPathValue("name", "nonexistent")
	rec := httptest.NewRecorder()

	h.Get(rec, req)
	if rec.Code != http.StatusNotFound {
		t.Errorf("status = %d, want 404", rec.Code)
	}
}

func TestHandler_Get_Success_IncludesBodyAndResources(t *testing.T) {
	svc := &fakeService{
		getRes: &skills.Skill{
			Name:        "found-skill",
			Description: "Found skill desc",
			Scope:       skills.ScopeProject,
			Source:      ".agents",
			Path:        "/proj/.agents/skills/found-skill",
			Body:        "# Detailed body markdown",
			Resources:   []string{"scripts/run.sh"},
		},
	}
	h := skillsapi.NewHandler(svc)
	req := httptest.NewRequest(http.MethodGet, "/api/skills/items/found-skill", nil).WithContext(authedContext())
	req.SetPathValue("name", "found-skill")
	rec := httptest.NewRecorder()

	h.Get(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200", rec.Code)
	}

	var resp skillsapi.SkillDTO
	if err := json.Unmarshal(rec.Body.Bytes(), &resp); err != nil {
		t.Fatalf("unmarshal response: %v", err)
	}
	if resp.Name != "found-skill" || resp.Body != "# Detailed body markdown" || len(resp.Resources) != 1 {
		t.Errorf("resp = %+v", resp)
	}

	var rawMap map[string]any
	if err := json.Unmarshal(rec.Body.Bytes(), &rawMap); err != nil {
		t.Fatalf("unmarshal raw: %v", err)
	}
	if rawMap["body"] != "# Detailed body markdown" {
		t.Errorf("raw body = %v, want # Detailed body markdown", rawMap["body"])
	}
}

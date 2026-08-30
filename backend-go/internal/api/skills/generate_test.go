package skills_test

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"testing"

	bifrostai "amiro/backend/internal/ai/bifrost"
	skillsapi "amiro/backend/internal/api/skills"
)

type fakeEngine struct {
	object json.RawMessage
	err    error
}

func (f *fakeEngine) GenerateObject(ctx context.Context, resolved bifrostai.ResolvedModel, system string, messages []bifrostai.Message, schema json.RawMessage) (json.RawMessage, *bifrostai.Usage, error) {
	return f.object, nil, f.err
}

func TestHandler_Generate_Unauthorized(t *testing.T) {
	h := skillsapi.NewHandler(&fakeService{}, &fakeEngine{})
	req := httptest.NewRequest(http.MethodPost, "/api/skills/generate", nil)
	rec := httptest.NewRecorder()

	h.Generate(rec, req)
	if rec.Code != http.StatusUnauthorized {
		t.Errorf("status = %d, want 401", rec.Code)
	}
}

func TestHandler_Generate_Success(t *testing.T) {
	engine := &fakeEngine{
		object: json.RawMessage(`{"name":"pdf-form-fill","description":"Fills PDF forms. Use when the user needs to populate a template.","body":"# PDF Form Fill\n\nSteps..."}`),
	}
	h := skillsapi.NewHandler(&fakeService{}, engine)
	body, _ := json.Marshal(map[string]any{"message": "a skill that fills PDF forms"})
	req := httptest.NewRequest(http.MethodPost, "/api/skills/generate", bytes.NewReader(body)).WithContext(authedContext())
	rec := httptest.NewRecorder()

	h.Generate(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200: %s", rec.Code, rec.Body.String())
	}
	var out struct {
		Name        string `json:"name"`
		Description string `json:"description"`
		Body        string `json:"body"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &out); err != nil {
		t.Fatalf("response is not the generated object: %v (body: %s)", err, rec.Body.String())
	}
	if out.Name != "pdf-form-fill" || out.Description == "" || out.Body == "" {
		t.Errorf("generated object = %+v", out)
	}
}

// TestHandler_Generate_MalformedModelResponseIsCleanError proves a model
// reply GenerateObject itself rejects (invalid JSON, per
// bifrost.Client.GenerateObject's json.Valid check) surfaces as an
// ordinary 500 response, never a panic -- the route never touches disk or
// unmarshals the object itself, so there is nothing here for a malformed
// reply to corrupt beyond the response it produces.
func TestHandler_Generate_MalformedModelResponseIsCleanError(t *testing.T) {
	engine := &fakeEngine{err: errors.New("model did not return valid JSON for the requested schema")}
	h := skillsapi.NewHandler(&fakeService{}, engine)
	body, _ := json.Marshal(map[string]any{"message": "a skill"})
	req := httptest.NewRequest(http.MethodPost, "/api/skills/generate", bytes.NewReader(body)).WithContext(authedContext())
	rec := httptest.NewRecorder()

	h.Generate(rec, req)
	if rec.Code != http.StatusInternalServerError {
		t.Errorf("status = %d, want 500", rec.Code)
	}
}

func TestHandler_Generate_NoEngineConfigured(t *testing.T) {
	h := skillsapi.NewHandler(&fakeService{}, nil)
	body, _ := json.Marshal(map[string]any{"message": "a skill"})
	req := httptest.NewRequest(http.MethodPost, "/api/skills/generate", bytes.NewReader(body)).WithContext(authedContext())
	rec := httptest.NewRecorder()

	h.Generate(rec, req)
	if rec.Code != http.StatusInternalServerError {
		t.Errorf("status = %d, want 500", rec.Code)
	}
}

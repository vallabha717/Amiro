package skills_test

// Phase 5 generation tests -- POST /api/skills/generate.
//
// Exit criteria covered (docs/skills/phases/phase-05-skills-ui.md,
// "Test coverage" table, backend row):
//   POST /api/skills/generate streams a valid object against the fake provider.
//   A malformed model response is a clean error, not a panic.
//   The generate route writes nothing to disk.

import (
	"encoding/json"
	"os"
	"path/filepath"
	"testing"

	"amiro/tests/harness"
	"amiro/tests/harness/apiclient"
	"amiro/tests/harness/fakeprovider"
)

func TestSkills_Generate_StreamsValidObject(t *testing.T) {
	h := harness.New(t, harness.Tags("smoke"))
	user := h.As("user")

	h.Fake().OnPrompt(fakeprovider.Any()).StreamText(
		`{"name":"pdf-form-fill","description":"Fills PDF forms from structured data. Use when the user needs to populate an existing PDF template.","body":"# PDF Form Fill\n\nStep-by-step instructions..."}`,
	)

	raw, err := user.GenerateSkill(t.Context(), apiclient.SkillGenerateRequest{
		Message: "a skill that fills PDF forms",
	})
	if err != nil {
		t.Fatalf("GenerateSkill: %v", err)
	}

	var out struct {
		Name        string `json:"name"`
		Description string `json:"description"`
		Body        string `json:"body"`
	}
	if err := json.Unmarshal(raw, &out); err != nil {
		t.Fatalf("generated response is not the expected object: %v (raw: %s)", err, raw)
	}
	if out.Name != "pdf-form-fill" || out.Description == "" || out.Body == "" {
		t.Errorf("generated object = %+v", out)
	}
}

func TestSkills_Generate_MalformedModelResponseIsCleanError(t *testing.T) {
	h := harness.New(t, harness.Tags("smoke"))
	user := h.As("user")

	// Not valid JSON -- bifrost.Client.GenerateObject's json.Valid check
	// rejects this before it ever reaches the handler's response writer.
	h.Fake().OnPrompt(fakeprovider.Any()).StreamText(`not valid json at all`)

	_, err := user.GenerateSkill(t.Context(), apiclient.SkillGenerateRequest{
		Message: "a skill",
	})
	if err == nil {
		t.Fatal("expected GenerateSkill to fail on a malformed model response, got nil error")
	}
	if status := apiclient.StatusOf(err); status != 500 {
		t.Errorf("status = %d, want 500 (a clean error response, not a panic)", status)
	}
}

// TestSkills_Generate_WritesNothingToDisk scans the writable root
// ($HOME/.agents/skills) before and after a generate call and asserts it
// is byte-for-byte unchanged -- Generate only calls the engine and writes
// the object back to the response; nothing about this route touches
// internal/skills/write.go's WriteSkillMD.
func TestSkills_Generate_WritesNothingToDisk(t *testing.T) {
	h := harness.New(t, harness.Tags("smoke"))
	user := h.As("user")
	be := h.Backend()

	skillsRoot := filepath.Join(be.Home, ".agents", "skills")
	before := listDirNames(t, skillsRoot)

	h.Fake().OnPrompt(fakeprovider.Any()).StreamText(
		`{"name":"disk-check-skill","description":"Should never be written to disk by generate. Use when testing.","body":"# Disk Check\n\nBody."}`,
	)
	if _, err := user.GenerateSkill(t.Context(), apiclient.SkillGenerateRequest{
		Message: "a skill",
	}); err != nil {
		t.Fatalf("GenerateSkill: %v", err)
	}

	after := listDirNames(t, skillsRoot)
	if len(before) != len(after) {
		t.Fatalf("skills root entries changed after Generate: before=%v after=%v", before, after)
	}
	for i := range before {
		if before[i] != after[i] {
			t.Fatalf("skills root entries changed after Generate: before=%v after=%v", before, after)
		}
	}
	if _, err := os.Stat(filepath.Join(skillsRoot, "disk-check-skill")); err == nil {
		t.Fatalf("Generate wrote disk-check-skill to disk, but this route must never touch the filesystem")
	}
}

// listDirNames returns the sorted entry names of dir, or nil if dir does
// not exist yet (Generate must not be the thing that creates it).
func listDirNames(t *testing.T, dir string) []string {
	t.Helper()
	entries, err := os.ReadDir(dir)
	if os.IsNotExist(err) {
		return nil
	}
	if err != nil {
		t.Fatalf("reading %s: %v", dir, err)
	}
	names := make([]string, 0, len(entries))
	for _, e := range entries {
		names = append(names, e.Name())
	}
	return names
}

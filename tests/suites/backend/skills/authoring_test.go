package skills_test

// Phase 4 authoring API tests — appended to the existing skills_test.go suite.
//
// These tests exercise POST /api/skills, PUT /api/skills/items/{name},
// DELETE /api/skills/items/{name}, and POST /api/skills/items/{name}/duplicate
// against a real running backend.
//
// Exit criteria covered:
//   Criterion 2: Create then immediately List shows the skill (no sleep).
//   Criterion 3: Every invalid name shape returns 400 and no directory is created.
//   Criterion 4: PUT on a non-writable skill returns 409 naming the source.
//   Criterion 5: A colon in the description survives write → read round-trip.

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"amiro/tests/harness"
	"amiro/tests/harness/apiclient"
)

// postSkill is an ergonomic helper for creating skills in authoring tests.
func postSkill(t *testing.T, user *apiclient.Client, req apiclient.SkillWriteRequest) (apiclient.SkillWriteResponse, error) {
	t.Helper()
	return user.CreateSkill(t.Context(), req)
}

// ---------------------------------------------------------------------------
// Criterion 2: Create → List shows immediately
// ---------------------------------------------------------------------------

func TestSkills_Create_ThenListShowsImmediately(t *testing.T) {
	h := harness.New(t, harness.Tags("smoke"))
	user := h.As("user")
	be := h.Backend()

	// Warm the cache first so List has a cached entry.
	initialList, err := user.ListSkills(t.Context(), be.WorkspaceRoot)
	if err != nil {
		t.Fatalf("initial ListSkills: %v", err)
	}
	for _, s := range initialList.Items {
		if s.Name == "my-new-skill" {
			t.Fatalf("skill 'my-new-skill' unexpectedly already in initial list")
		}
	}

	resp, err := postSkill(t, user, apiclient.SkillWriteRequest{
		Name:        "my-new-skill",
		Description: "A skill created in the authoring test",
		Body:        "## Instructions\n\nDo something useful.",
	})
	if err != nil {
		t.Fatalf("CreateSkill: %v", err)
	}
	if resp.Skill.Name != "my-new-skill" {
		t.Errorf("created skill name = %q, want %q", resp.Skill.Name, "my-new-skill")
	}
	if !resp.Skill.Writable {
		t.Errorf("created skill writable = false, want true")
	}

	// Immediately list — no sleep — must appear because Create invalidated the cache.
	list, err := user.ListSkills(t.Context(), be.WorkspaceRoot)
	if err != nil {
		t.Fatalf("ListSkills after Create: %v", err)
	}
	var found bool
	for _, s := range list.Items {
		if s.Name == "my-new-skill" {
			found = true
			break
		}
	}
	if !found {
		t.Errorf("newly created skill 'my-new-skill' not visible in list immediately after create")
	}

	// Verify on disk.
	skillDir := filepath.Join(be.Home, ".agents", "skills", "my-new-skill")
	if _, err := os.Stat(filepath.Join(skillDir, "SKILL.md")); err != nil {
		t.Errorf("SKILL.md not found at %s: %v", skillDir, err)
	}
}

// ---------------------------------------------------------------------------
// Criterion 2: Duplicate name returns 409
// ---------------------------------------------------------------------------

func TestSkills_Create_DuplicateNameReturns409(t *testing.T) {
	h := harness.New(t)
	user := h.As("user")

	req := apiclient.SkillWriteRequest{
		Name:        "dup-skill",
		Description: "First copy",
		Body:        "body",
	}
	if _, err := postSkill(t, user, req); err != nil {
		t.Fatalf("first CreateSkill: %v", err)
	}

	// Second create with same name must fail 409.
	_, err := postSkill(t, user, req)
	if err == nil {
		t.Fatal("second CreateSkill with same name: expected error, got nil")
	}
	if apiclient.StatusOf(err) != 409 {
		t.Errorf("second CreateSkill status = %d, want 409", apiclient.StatusOf(err))
	}
}

// ---------------------------------------------------------------------------
// Criterion 3: Invalid name shapes → 400 + no directory created
// ---------------------------------------------------------------------------

func TestSkills_Create_InvalidNameTable(t *testing.T) {
	cases := []struct {
		name        string
		skillName   string
		description string
	}{
		{"parent_traversal", "../escaped", "desc"},
		{"absolute_path", "/etc/passwd", "desc"},
		{"uppercase", "MySkill", "desc"},
		{"double_hyphen", "my--skill", "desc"},
		{"leading_hyphen", "-skill", "desc"},
		{"trailing_hyphen", "skill-", "desc"},
		{"too_long", strings.Repeat("a", 65), "desc"},
		{"empty_name", "", "desc"},
	}

	h := harness.New(t)
	user := h.As("user")
	be := h.Backend()

	for _, tc := range cases {
		tc := tc
		t.Run(tc.name, func(t *testing.T) {
			_, err := postSkill(t, user, apiclient.SkillWriteRequest{
				Name:        tc.skillName,
				Description: tc.description,
				Body:        "body",
			})
			if err == nil {
				t.Fatalf("CreateSkill with name=%q: expected error, got nil", tc.skillName)
			}
			if apiclient.StatusOf(err) != 400 {
				t.Errorf("CreateSkill with name=%q status = %d, want 400", tc.skillName, apiclient.StatusOf(err))
			}

			// Criterion 3: no directory created.
			candidate := filepath.Join(be.Home, ".agents", "skills", tc.skillName)
			if _, statErr := os.Stat(candidate); statErr == nil {
				t.Errorf("Criterion 3 violated: directory %s was created for invalid name %q", candidate, tc.skillName)
			}
		})
	}
}

// ---------------------------------------------------------------------------
// Criterion 3: Unknown frontmatter key → 400 naming the key
// ---------------------------------------------------------------------------

func TestSkills_Create_UnknownFrontmatterKeyReturns400(t *testing.T) {
	h := harness.New(t)
	user := h.As("user")

	_, err := postSkill(t, user, apiclient.SkillWriteRequest{
		Name:        "valid-name",
		Description: "valid desc",
		Body:        "body",
		Frontmatter: map[string]any{"unknown-key": "value"},
	})
	if err == nil {
		t.Fatal("expected 400 for unknown frontmatter key, got nil")
	}
	if apiclient.StatusOf(err) != 400 {
		t.Errorf("status = %d, want 400", apiclient.StatusOf(err))
	}
	if !strings.Contains(err.Error(), "unknown-key") {
		t.Errorf("error %q does not name the unknown key", err.Error())
	}
}

// ---------------------------------------------------------------------------
// Criterion 3: Over-length description → 400
// ---------------------------------------------------------------------------

func TestSkills_Create_OverLengthDescriptionReturns400(t *testing.T) {
	h := harness.New(t)
	user := h.As("user")

	_, err := postSkill(t, user, apiclient.SkillWriteRequest{
		Name:        "valid-name",
		Description: strings.Repeat("a", 1025),
		Body:        "body",
	})
	if err == nil {
		t.Fatal("expected 400 for over-length description, got nil")
	}
	if apiclient.StatusOf(err) != 400 {
		t.Errorf("status = %d, want 400", apiclient.StatusOf(err))
	}
}

// ---------------------------------------------------------------------------
// Criterion 4: PUT on a non-writable skill returns 409 naming the source
// ---------------------------------------------------------------------------

func TestSkills_Update_ReadOnlySkillReturns409(t *testing.T) {
	h := harness.New(t)
	user := h.As("user")
	be := h.Backend()

	// Plant a skill in user ~/.claude/skills/ (non-writable source).
	claudeDir := filepath.Join(be.Home, ".claude", "skills")
	writeSkill(t, claudeDir, "claude-skill", "A Claude skill", "body")

	// GET first to confirm it's discovered.
	skill, err := user.GetSkill(t.Context(), "claude-skill")
	if err != nil {
		t.Fatalf("GetSkill: %v", err)
	}
	if skill.Writable {
		t.Skip("claude-skill unexpectedly marked writable; skipping")
	}

	originalContent, readErr := os.ReadFile(filepath.Join(claudeDir, "claude-skill", "SKILL.md"))
	if readErr != nil {
		t.Fatalf("read original SKILL.md: %v", readErr)
	}

	_, err = user.UpdateSkill(t.Context(), "claude-skill", apiclient.SkillWriteRequest{
		Name:        "claude-skill",
		Description: "modified",
		Body:        "modified body",
	})
	if err == nil {
		t.Fatal("UpdateSkill on read-only skill: expected error, got nil")
	}
	if apiclient.StatusOf(err) != 409 {
		t.Errorf("status = %d, want 409", apiclient.StatusOf(err))
	}
	if !strings.Contains(err.Error(), ".claude") {
		t.Errorf("409 error %q does not name '.claude' source", err.Error())
	}

	// File must be byte-identical after the rejected write.
	afterContent, readErr := os.ReadFile(filepath.Join(claudeDir, "claude-skill", "SKILL.md"))
	if readErr != nil {
		t.Fatalf("read SKILL.md after rejected update: %v", readErr)
	}
	if string(originalContent) != string(afterContent) {
		t.Errorf("SKILL.md changed after a rejected update — atomic write invariant violated")
	}
}

// ---------------------------------------------------------------------------
// Criterion 5: Colon in description survives write → read
// ---------------------------------------------------------------------------

func TestSkills_Create_ColonDescriptionRoundTrips(t *testing.T) {
	h := harness.New(t)
	user := h.As("user")

	desc := "Handles: code review, refactoring: all kinds"
	resp, err := postSkill(t, user, apiclient.SkillWriteRequest{
		Name:        "colon-skill",
		Description: desc,
		Body:        "body",
	})
	if err != nil {
		t.Fatalf("CreateSkill with colon description: %v", err)
	}
	if resp.Skill.Description != desc {
		t.Errorf("description round-trip failed: got %q, want %q", resp.Skill.Description, desc)
	}

	// Re-read via GET.
	skill, err := user.GetSkill(t.Context(), "colon-skill")
	if err != nil {
		t.Fatalf("GetSkill: %v", err)
	}
	if skill.Description != desc {
		t.Errorf("GetSkill description = %q, want %q", skill.Description, desc)
	}
}

// ---------------------------------------------------------------------------
// DELETE: read-only skill → 409
// ---------------------------------------------------------------------------

func TestSkills_Delete_ReadOnlySkillReturns409(t *testing.T) {
	h := harness.New(t)
	user := h.As("user")
	be := h.Backend()

	claudeDir := filepath.Join(be.Home, ".claude", "skills")
	writeSkill(t, claudeDir, "claude-del", "Del target", "body")

	if _, err := user.GetSkill(t.Context(), "claude-del"); err != nil {
		t.Fatalf("GetSkill: %v", err)
	}

	err := user.DeleteSkill(t.Context(), "claude-del", false)
	if err == nil {
		t.Fatal("DeleteSkill on read-only skill: expected error, got nil")
	}
	if apiclient.StatusOf(err) != 409 {
		t.Errorf("status = %d, want 409", apiclient.StatusOf(err))
	}

	// Directory must still exist.
	if _, statErr := os.Stat(filepath.Join(claudeDir, "claude-del")); statErr != nil {
		t.Errorf("skill directory removed after rejected delete: %v", statErr)
	}
}

// ---------------------------------------------------------------------------
// DELETE: unexpected files → 422 without force, succeeds with force
// ---------------------------------------------------------------------------

func TestSkills_Delete_UnexpectedFilesReturns422_ForcePasses(t *testing.T) {
	h := harness.New(t)
	user := h.As("user")
	be := h.Backend()

	// Create writable skill.
	if _, err := postSkill(t, user, apiclient.SkillWriteRequest{
		Name:        "extra-files-skill",
		Description: "Has extras",
		Body:        "body",
	}); err != nil {
		t.Fatalf("CreateSkill: %v", err)
	}

	// Add an unexpected file directly on disk.
	skillDir := filepath.Join(be.Home, ".agents", "skills", "extra-files-skill")
	unexpected := filepath.Join(skillDir, "custom-extra.txt")
	if err := os.WriteFile(unexpected, []byte("extra"), 0o644); err != nil {
		t.Fatalf("write extra file: %v", err)
	}

	// Delete without force → 422.
	err := user.DeleteSkill(t.Context(), "extra-files-skill", false)
	if err == nil {
		t.Fatal("DeleteSkill with unexpected files (force=false): expected error, got nil")
	}
	if apiclient.StatusOf(err) != 422 {
		t.Errorf("status = %d, want 422", apiclient.StatusOf(err))
	}
	if !strings.Contains(err.Error(), "custom-extra.txt") {
		t.Errorf("422 error %q does not name the unexpected file", err.Error())
	}

	// Directory still exists.
	if _, statErr := os.Stat(skillDir); statErr != nil {
		t.Errorf("skill directory removed even though force=false rejected the delete")
	}

	// Delete with force → success.
	if err := user.DeleteSkill(t.Context(), "extra-files-skill", true); err != nil {
		t.Fatalf("DeleteSkill with force=true: %v", err)
	}
	if _, statErr := os.Stat(skillDir); statErr == nil {
		t.Errorf("skill directory still exists after force delete")
	}
}

// ---------------------------------------------------------------------------
// DELETE: clean writable skill succeeds
// ---------------------------------------------------------------------------

func TestSkills_Delete_CleanSkillSucceeds(t *testing.T) {
	h := harness.New(t, harness.Tags("smoke"))
	user := h.As("user")
	be := h.Backend()

	if _, err := postSkill(t, user, apiclient.SkillWriteRequest{
		Name:        "clean-skill",
		Description: "Will be deleted",
		Body:        "body",
	}); err != nil {
		t.Fatalf("CreateSkill: %v", err)
	}

	if err := user.DeleteSkill(t.Context(), "clean-skill", false); err != nil {
		t.Fatalf("DeleteSkill: %v", err)
	}

	skillDir := filepath.Join(be.Home, ".agents", "skills", "clean-skill")
	if _, err := os.Stat(skillDir); err == nil {
		t.Errorf("skill directory still exists after delete")
	}

	// Must no longer appear in list.
	list, err := user.ListSkills(t.Context())
	if err != nil {
		t.Fatalf("ListSkills after delete: %v", err)
	}
	for _, s := range list.Items {
		if s.Name == "clean-skill" {
			t.Errorf("deleted skill 'clean-skill' still visible in list")
		}
	}
}

// ---------------------------------------------------------------------------
// Duplicate: copies the skill into ~/.agents/skills/
// ---------------------------------------------------------------------------

func TestSkills_Duplicate_CopiesSkillToWritableRoot(t *testing.T) {
	h := harness.New(t)
	user := h.As("user")
	be := h.Backend()

	// Plant a project-scope skill to duplicate.
	agentsDir := filepath.Join(be.WorkspaceRoot, ".agents", "skills")
	writeSkill(t, agentsDir, "src-skill", "Source skill", "## Body")

	resp, err := user.DuplicateSkill(t.Context(), "src-skill", be.WorkspaceRoot)
	if err != nil {
		t.Fatalf("DuplicateSkill: %v", err)
	}
	if resp.Skill.Scope != apiclient.SkillScopeUser {
		t.Errorf("duplicate scope = %q, want user", resp.Skill.Scope)
	}
	if !resp.Skill.Writable {
		t.Errorf("duplicate writable = false, want true")
	}

	// SKILL.md must exist in the writable root.
	dstDir := filepath.Join(be.Home, ".agents", "skills", resp.Skill.Name)
	if _, err := os.Stat(filepath.Join(dstDir, "SKILL.md")); err != nil {
		t.Errorf("SKILL.md not found in duplicate at %s: %v", dstDir, err)
	}
}

// ---------------------------------------------------------------------------
// Duplicate: naming collision appends -copy suffix
// ---------------------------------------------------------------------------

func TestSkills_Duplicate_CollisionAppendsCopySuffix(t *testing.T) {
	h := harness.New(t)
	user := h.As("user")
	be := h.Backend()

	// Create a skill in the writable root.
	if _, err := postSkill(t, user, apiclient.SkillWriteRequest{
		Name:        "collidable",
		Description: "Original",
		Body:        "body",
	}); err != nil {
		t.Fatalf("CreateSkill collidable: %v", err)
	}

	// Also put a project-scope skill with the same name so Duplicate finds it.
	agentsDir := filepath.Join(be.WorkspaceRoot, ".agents", "skills")
	writeSkill(t, agentsDir, "collidable", "Project version", "body")

	resp, err := user.DuplicateSkill(t.Context(), "collidable", be.WorkspaceRoot)
	if err != nil {
		t.Fatalf("DuplicateSkill on collision: %v", err)
	}
	if !strings.Contains(resp.Skill.Name, "collidable") {
		t.Errorf("duplicate name = %q, expected to contain 'collidable'", resp.Skill.Name)
	}
	if resp.Skill.Name == "collidable" {
		t.Errorf("duplicate name = %q, expected a suffixed copy name", resp.Skill.Name)
	}
}

// ---------------------------------------------------------------------------
// Bug 1 Test: Duplicate retains frontmatter on collision rename
// ---------------------------------------------------------------------------

func TestSkills_Duplicate_RetainsFrontmatterOnCollision(t *testing.T) {
	h := harness.New(t)
	user := h.As("user")
	be := h.Backend()

	// 1. Pre-occupy target name in writable root so duplicate must rename.
	if _, err := postSkill(t, user, apiclient.SkillWriteRequest{
		Name:        "fm-skill",
		Description: "Occupier",
		Body:        "body",
	}); err != nil {
		t.Fatalf("CreateSkill fm-skill: %v", err)
	}

	// 2. Plant a source skill in project scope with extra frontmatter.
	agentsDir := filepath.Join(be.WorkspaceRoot, ".agents", "skills")
	writeSkill(t, agentsDir, "fm-skill", "Source description", "## Body instructions",
		"disable-model-invocation: true",
		"license: MIT",
		"compatibility: claude-3-5-sonnet",
	)

	// 3. Duplicate it.
	resp, err := user.DuplicateSkill(t.Context(), "fm-skill", be.WorkspaceRoot)
	if err != nil {
		t.Fatalf("DuplicateSkill: %v", err)
	}
	if resp.Skill.Name == "fm-skill" {
		t.Fatalf("expected collision rename, got %q", resp.Skill.Name)
	}

	// 4. Assert extra frontmatter was NOT lost on the rename branch.
	if !resp.Skill.DisableModelInvocation {
		t.Errorf("expected DisableModelInvocation = true on duplicated skill, got false")
	}
	if resp.Skill.License != "MIT" {
		t.Errorf("expected License = 'MIT', got %q", resp.Skill.License)
	}
	if resp.Skill.Compatibility != "claude-3-5-sonnet" {
		t.Errorf("expected Compatibility = 'claude-3-5-sonnet', got %q", resp.Skill.Compatibility)
	}

	// Also verify SKILL.md on disk contains disable-model-invocation
	dstSKILL := filepath.Join(be.Home, ".agents", "skills", resp.Skill.Name, "SKILL.md")
	content, readErr := os.ReadFile(dstSKILL)
	if readErr != nil {
		t.Fatalf("read duplicated SKILL.md: %v", readErr)
	}
	if !strings.Contains(string(content), "disable-model-invocation: true") {
		t.Errorf("duplicated SKILL.md missing 'disable-model-invocation: true'; content:\n%s", string(content))
	}
}

// ---------------------------------------------------------------------------
// Bug 2 Test: Duplicate rejects invalid source name
// ---------------------------------------------------------------------------

func TestSkills_Duplicate_InvalidSourceNameRejected(t *testing.T) {
	h := harness.New(t)
	user := h.As("user")
	be := h.Backend()

	// 1. Plant a skill with invalid name (e.g. UpperCase/spaces) in a read-only root where Phase 0 allows discovery.
	claudeDir := filepath.Join(be.Home, ".claude", "skills")
	writeSkill(t, claudeDir, "UpperSkill", "Upper skill desc", "body")

	// Verify it was discovered.
	_, err := user.GetSkill(t.Context(), "UpperSkill")
	if err != nil {
		t.Fatalf("GetSkill UpperSkill: %v", err)
	}

	// 2. Attempt to duplicate it. Must be rejected because 'UpperSkill' is invalid for ~/.agents/skills/.
	_, err = user.DuplicateSkill(t.Context(), "UpperSkill")
	if err == nil {
		t.Fatal("expected DuplicateSkill with invalid name to fail, got nil")
	}
	if apiclient.StatusOf(err) != 400 {
		t.Errorf("status = %d, want 400", apiclient.StatusOf(err))
	}

	// 3. Ensure no directory was created in writable root.
	candidateDir := filepath.Join(be.Home, ".agents", "skills", "UpperSkill")
	if _, statErr := os.Stat(candidateDir); statErr == nil {
		t.Errorf("directory %s was created despite validation failure", candidateDir)
	}
}


// ---------------------------------------------------------------------------
// Unauthenticated write returns 401
// ---------------------------------------------------------------------------

func TestSkills_Create_UnauthenticatedReturns401(t *testing.T) {
	h := harness.New(t, harness.Tags("smoke"))
	be := h.Backend()
	anon := h.As("user").Anonymous()

	_ = be // ensure backend started
	_, err := anon.CreateSkill(t.Context(), apiclient.SkillWriteRequest{
		Name:        "sneaky",
		Description: "should fail",
		Body:        "body",
	})
	if err == nil {
		t.Fatal("expected 401 for unauthenticated create, got nil")
	}
	if apiclient.StatusOf(err) != 401 {
		t.Errorf("status = %d, want 401", apiclient.StatusOf(err))
	}
}

// ---------------------------------------------------------------------------
// Update: full round-trip on writable skill
// ---------------------------------------------------------------------------

func TestSkills_Update_WritableSkillSucceeds(t *testing.T) {
	h := harness.New(t, harness.Tags("smoke"))
	user := h.As("user")

	if _, err := postSkill(t, user, apiclient.SkillWriteRequest{
		Name:        "updatable",
		Description: "Before update",
		Body:        "original body",
	}); err != nil {
		t.Fatalf("CreateSkill: %v", err)
	}

	resp, err := user.UpdateSkill(t.Context(), "updatable", apiclient.SkillWriteRequest{
		Name:        "updatable",
		Description: "After update",
		Body:        "updated body",
	})
	if err != nil {
		t.Fatalf("UpdateSkill: %v", err)
	}
	if resp.Skill.Description != "After update" {
		t.Errorf("description after update = %q, want %q", resp.Skill.Description, "After update")
	}

	// Confirm via GET.
	skill, err := user.GetSkill(t.Context(), "updatable")
	if err != nil {
		t.Fatalf("GetSkill: %v", err)
	}
	if skill.Body != "updated body" {
		t.Errorf("body after update = %q, want %q", skill.Body, "updated body")
	}
}

// ---------------------------------------------------------------------------
// Portability warning is returned (not rejected) for vendor prefix names
// ---------------------------------------------------------------------------

func TestSkills_Create_VendorPrefixNameReturnsWarning(t *testing.T) {
	h := harness.New(t)
	user := h.As("user")

	resp, err := postSkill(t, user, apiclient.SkillWriteRequest{
		Name:        "claude-helper",
		Description: "Vendor-prefixed skill",
		Body:        "body",
	})
	// Must succeed (warning, not error).
	if err != nil {
		t.Fatalf("CreateSkill with vendor-prefix name: expected success with warning, got error: %v", err)
	}
	if resp.Skill.Name != "claude-helper" {
		t.Errorf("skill name = %q, want %q", resp.Skill.Name, "claude-helper")
	}
	var hasWarning bool
	for _, w := range resp.Warnings {
		if strings.Contains(w.Message, "portability") || strings.Contains(w.Message, "vendor") {
			hasWarning = true
		}
	}
	if !hasWarning {
		// Check raw JSON for warnings field.
		raw, _ := json.Marshal(resp)
		t.Logf("response JSON: %s", raw)
		t.Errorf("expected portability warning in response, got warnings=%v", resp.Warnings)
	}
}

// ---------------------------------------------------------------------------
// Duplicate of non-existent skill → 404
// ---------------------------------------------------------------------------

func TestSkills_Duplicate_NonExistentSkillReturns404(t *testing.T) {
	h := harness.New(t, harness.Tags("smoke"))
	user := h.As("user")

	_, err := user.DuplicateSkill(t.Context(), "does-not-exist")
	if err == nil {
		t.Fatal("expected 404 for duplicate of non-existent skill, got nil")
	}
	if apiclient.StatusOf(err) != 404 {
		t.Errorf("status = %d, want 404", apiclient.StatusOf(err))
	}
}

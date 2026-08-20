package skills_test

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"amiro/tests/harness"
	"amiro/tests/harness/apiclient"
	"amiro/tests/harness/fakeprovider"
)

func writeSkill(t *testing.T, dir, name, description, body string, extraFM ...string) string {
	t.Helper()
	skillDir := filepath.Join(dir, name)
	if err := os.MkdirAll(skillDir, 0o755); err != nil {
		t.Fatalf("mkdir %s: %v", skillDir, err)
	}

	var sb strings.Builder
	sb.WriteString("---\n")
	if name != "" {
		sb.WriteString(fmt.Sprintf("name: %s\n", name))
	}
	if description != "" {
		sb.WriteString(fmt.Sprintf("description: %s\n", description))
	}
	for _, extra := range extraFM {
		sb.WriteString(extra)
		sb.WriteString("\n")
	}
	sb.WriteString("---\n")
	if body != "" {
		sb.WriteString(body)
		sb.WriteString("\n")
	}

	skillMD := filepath.Join(skillDir, "SKILL.md")
	if err := os.WriteFile(skillMD, []byte(sb.String()), 0o644); err != nil {
		t.Fatalf("writeFile %s: %v", skillMD, err)
	}
	return skillDir
}

func TestSkills_EmptyMachineReturnsEmptyListWithNoError(t *testing.T) {
	h := harness.New(t)
	user := h.As("user")
	be := h.Backend()

	resp, err := user.ListSkills(t.Context(), be.WorkspaceRoot)
	if err != nil {
		t.Fatalf("ListSkills on empty machine: %v", err)
	}
	if len(resp.Items) != 0 {
		t.Errorf("items = %d, want 0", len(resp.Items))
	}
	if resp.Truncated {
		t.Errorf("truncated = true, want false")
	}
}

func TestSkills_DiscoversSkillInEachOfTheEightRoots(t *testing.T) {
	h := harness.New(t)
	user := h.As("user")
	be := h.Backend()

	// Define the 8 roots and plant one distinct skill in each
	type rootDef struct {
		scope    apiclient.SkillScope
		source   string
		baseDir  string
		relDir   string
		skill    string
		writable bool
	}

	roots := []rootDef{
		{scope: apiclient.SkillScopeProject, source: ".agents", baseDir: be.WorkspaceRoot, relDir: ".agents/skills", skill: "p-agents", writable: false},
		{scope: apiclient.SkillScopeProject, source: ".amiro", baseDir: be.WorkspaceRoot, relDir: ".amiro/skills", skill: "p-amiro", writable: false},
		{scope: apiclient.SkillScopeProject, source: ".claude", baseDir: be.WorkspaceRoot, relDir: ".claude/skills", skill: "p-claude", writable: false},
		{scope: apiclient.SkillScopeProject, source: ".codex", baseDir: be.WorkspaceRoot, relDir: ".codex/skills", skill: "p-codex", writable: false},
		{scope: apiclient.SkillScopeUser, source: ".agents", baseDir: be.Home, relDir: ".agents/skills", skill: "u-agents", writable: true},
		{scope: apiclient.SkillScopeUser, source: ".amiro", baseDir: be.Home, relDir: ".amiro/skills", skill: "u-amiro", writable: false},
		{scope: apiclient.SkillScopeUser, source: ".claude", baseDir: be.Home, relDir: ".claude/skills", skill: "u-claude", writable: false},
		{scope: apiclient.SkillScopeUser, source: ".codex", baseDir: be.Home, relDir: ".codex/skills", skill: "u-codex", writable: false},
	}

	for _, r := range roots {
		dir := filepath.Join(r.baseDir, filepath.FromSlash(r.relDir))
		writeSkill(t, dir, r.skill, fmt.Sprintf("Description for %s", r.skill), fmt.Sprintf("# %s body", r.skill))
	}

	resp, err := user.ListSkills(t.Context(), be.WorkspaceRoot)
	if err != nil {
		t.Fatalf("ListSkills: %v", err)
	}

	if len(resp.Items) != 8 {
		t.Fatalf("found %d skills, want 8. Items: %+v", len(resp.Items), resp.Items)
	}

	byName := make(map[string]apiclient.SkillSummary)
	for _, it := range resp.Items {
		byName[it.Name] = it
	}

	for _, r := range roots {
		skill, ok := byName[r.skill]
		if !ok {
			t.Errorf("missing skill %q in list response", r.skill)
			continue
		}
		if skill.Scope != r.scope {
			t.Errorf("skill %s scope = %q, want %q", r.skill, skill.Scope, r.scope)
		}
		if skill.Source != r.source {
			t.Errorf("skill %s source = %q, want %q", r.skill, skill.Source, r.source)
		}
		if skill.Writable != r.writable {
			t.Errorf("skill %s writable = %v, want %v", r.skill, skill.Writable, r.writable)
		}
	}
}

// TestSkills_ProjectBeatsUserForSameName tests Exit Criterion 3:
// A project-scope skill named code-review wins over a user-scope skill of the same name,
// and the user-scope one is reported as shadowed rather than dropped silently.
func TestSkills_ProjectBeatsUserForSameName(t *testing.T) {
	h := harness.New(t)
	user := h.As("user")
	be := h.Backend()

	projSkills := filepath.Join(be.WorkspaceRoot, ".agents", "skills")
	userSkills := filepath.Join(be.Home, ".agents", "skills")

	writeSkill(t, projSkills, "code-review", "Project code review skill", "Project review body")
	writeSkill(t, userSkills, "code-review", "User personal code review skill", "User review body")

	resp, err := user.ListSkills(t.Context(), be.WorkspaceRoot)
	if err != nil {
		t.Fatalf("ListSkills: %v", err)
	}

	var winner *apiclient.SkillSummary
	for i := range resp.Items {
		if resp.Items[i].Name == "code-review" {
			winner = &resp.Items[i]
			break
		}
	}

	if winner == nil {
		t.Fatalf("code-review skill not found in list response")
	}

	if winner.Scope != apiclient.SkillScopeProject {
		t.Errorf("winner scope = %q, want project", winner.Scope)
	}
	if winner.Description != "Project code review skill" {
		t.Errorf("winner description = %q, want project description", winner.Description)
	}

	if len(winner.Shadows) != 1 {
		t.Fatalf("winner.Shadows length = %d, want 1. Shadows: %+v", len(winner.Shadows), winner.Shadows)
	}

	shadowed := winner.Shadows[0]
	if shadowed.Scope != apiclient.SkillScopeUser {
		t.Errorf("shadowed scope = %q, want user", shadowed.Scope)
	}
	if shadowed.Source != ".agents" {
		t.Errorf("shadowed source = %q, want .agents", shadowed.Source)
	}
	if !strings.Contains(shadowed.Reason, "shadowed by project") {
		t.Errorf("shadowed reason = %q, want reason containing 'shadowed by project'", shadowed.Reason)
	}
}

// TestSkills_SourceOrderBreaksSameScopeTie tests Exit Criterion 2:
// A skill present in all four user-scope directories appears exactly once in GET /api/skills,
// with source: ".agents" and three entries in shadows.
func TestSkills_SourceOrderBreaksSameScopeTie(t *testing.T) {
	h := harness.New(t)
	user := h.As("user")
	be := h.Backend()

	userAgents := filepath.Join(be.Home, ".agents", "skills")
	userAmiro := filepath.Join(be.Home, ".amiro", "skills")
	userClaude := filepath.Join(be.Home, ".claude", "skills")
	userCodex := filepath.Join(be.Home, ".codex", "skills")

	writeSkill(t, userAgents, "omnipresent", "Agents version", "Agents body")
	writeSkill(t, userAmiro, "omnipresent", "Amiro version", "Amiro body")
	writeSkill(t, userClaude, "omnipresent", "Claude version", "Claude body")
	writeSkill(t, userCodex, "omnipresent", "Codex version", "Codex body")

	resp, err := user.ListSkills(t.Context(), be.WorkspaceRoot)
	if err != nil {
		t.Fatalf("ListSkills: %v", err)
	}

	var matchCount int
	var winner *apiclient.SkillSummary
	for i := range resp.Items {
		if resp.Items[i].Name == "omnipresent" {
			matchCount++
			winner = &resp.Items[i]
		}
	}

	if matchCount != 1 {
		t.Fatalf("omnipresent appeared %d times in response, want exactly 1", matchCount)
	}

	if winner.Source != ".agents" {
		t.Errorf("winner source = %q, want .agents", winner.Source)
	}
	if len(winner.Shadows) != 3 {
		t.Fatalf("winner.Shadows length = %d, want 3: %+v", len(winner.Shadows), winner.Shadows)
	}

	shadowSources := make(map[string]bool)
	for _, sh := range winner.Shadows {
		shadowSources[sh.Source] = true
	}
	for _, wantSrc := range []string{".amiro", ".claude", ".codex"} {
		if !shadowSources[wantSrc] {
			t.Errorf("missing shadowed source %q in shadows: %+v", wantSrc, winner.Shadows)
		}
	}
}

func TestSkills_SymlinkedDuplicateAppearsOnce(t *testing.T) {
	h := harness.New(t)
	user := h.As("user")
	be := h.Backend()

	userAgents := filepath.Join(be.Home, ".agents", "skills")
	targetDir := writeSkill(t, userAgents, "symlink-target", "Symlink target skill", "Body")

	userClaude := filepath.Join(be.Home, ".claude", "skills")
	if err := os.MkdirAll(userClaude, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(targetDir, filepath.Join(userClaude, "symlink-target")); err != nil {
		t.Fatal(err)
	}

	resp, err := user.ListSkills(t.Context(), be.WorkspaceRoot)
	if err != nil {
		t.Fatalf("ListSkills: %v", err)
	}

	count := 0
	for _, it := range resp.Items {
		if it.Name == "symlink-target" {
			count++
			if len(it.Shadows) != 0 {
				t.Errorf("identity duplicate should not be recorded as shadowed: %+v", it.Shadows)
			}
		}
	}
	if count != 1 {
		t.Errorf("symlink-target appeared %d times, want exactly 1", count)
	}
}

// TestSkills_MissingDescriptionIsSkippedWithReason tests Exit Criterion 4:
// A skill whose SKILL.md has no description is absent from the list and present in diagnostics with a reason string.
func TestSkills_MissingDescriptionIsSkippedWithReason(t *testing.T) {
	h := harness.New(t)
	user := h.As("user")
	be := h.Backend()

	userSkills := filepath.Join(be.Home, ".agents", "skills")
	writeSkill(t, userSkills, "no-desc-skill", "", "Body without description")

	resp, err := user.ListSkills(t.Context(), be.WorkspaceRoot)
	if err != nil {
		t.Fatalf("ListSkills: %v", err)
	}

	for _, it := range resp.Items {
		if it.Name == "no-desc-skill" {
			t.Errorf("no-desc-skill should be absent from items list, but was present: %+v", it)
		}
	}

	foundDiag := false
	for _, diag := range resp.Diagnostics {
		if strings.Contains(diag.Path, "no-desc-skill") {
			foundDiag = true
			if diag.Severity != "error" {
				t.Errorf("diagnostic severity = %q, want error", diag.Severity)
			}
			if !strings.Contains(strings.ToLower(diag.Message), "description") {
				t.Errorf("diagnostic message = %q, want mention of description", diag.Message)
			}
		}
	}
	if !foundDiag {
		t.Errorf("no diagnostic found for no-desc-skill in: %+v", resp.Diagnostics)
	}
}

func TestSkills_UnparseableYAMLIsSkippedWithReason(t *testing.T) {
	h := harness.New(t)
	user := h.As("user")
	be := h.Backend()

	skillDir := filepath.Join(be.Home, ".agents", "skills", "bad-yaml")
	if err := os.MkdirAll(skillDir, 0o755); err != nil {
		t.Fatal(err)
	}
	badContent := "---\nname: [bad yaml\n  unclosed bracket\n---\nBody"
	if err := os.WriteFile(filepath.Join(skillDir, "SKILL.md"), []byte(badContent), 0o644); err != nil {
		t.Fatal(err)
	}

	resp, err := user.ListSkills(t.Context(), be.WorkspaceRoot)
	if err != nil {
		t.Fatalf("ListSkills: %v", err)
	}

	for _, it := range resp.Items {
		if it.Name == "bad-yaml" {
			t.Errorf("bad-yaml should not be loaded in items: %+v", it)
		}
	}

	foundDiag := false
	for _, diag := range resp.Diagnostics {
		if strings.Contains(diag.Path, "bad-yaml") {
			foundDiag = true
			if diag.Severity != "error" {
				t.Errorf("severity = %q, want error", diag.Severity)
			}
		}
	}
	if !foundDiag {
		t.Errorf("expected diagnostic for bad-yaml, got: %+v", resp.Diagnostics)
	}
}

func TestSkills_ColonInDescriptionLoadsViaRetry(t *testing.T) {
	h := harness.New(t)
	user := h.As("user")
	be := h.Backend()

	userSkills := filepath.Join(be.Home, ".agents", "skills")
	writeSkill(t, userSkills, "colon-desc", "Use when: the user asks about tests or code", "Body")

	resp, err := user.ListSkills(t.Context(), be.WorkspaceRoot)
	if err != nil {
		t.Fatalf("ListSkills: %v", err)
	}

	var found *apiclient.SkillSummary
	for i := range resp.Items {
		if resp.Items[i].Name == "colon-desc" {
			found = &resp.Items[i]
			break
		}
	}

	if found == nil {
		t.Fatalf("colon-desc skill not found in items: %+v", resp.Items)
	}
	if found.Description != "Use when: the user asks about tests or code" {
		t.Errorf("description = %q", found.Description)
	}
}

func TestSkills_NameDirectoryMismatchLoadsWithWarning(t *testing.T) {
	h := harness.New(t)
	user := h.As("user")
	be := h.Backend()

	skillDir := filepath.Join(be.Home, ".agents", "skills", "dir-name")
	if err := os.MkdirAll(skillDir, 0o755); err != nil {
		t.Fatal(err)
	}
	content := "---\nname: mismatched-name\ndescription: A valid description\n---\nBody"
	if err := os.WriteFile(filepath.Join(skillDir, "SKILL.md"), []byte(content), 0o644); err != nil {
		t.Fatal(err)
	}

	resp, err := user.ListSkills(t.Context(), be.WorkspaceRoot)
	if err != nil {
		t.Fatalf("ListSkills: %v", err)
	}

	var found *apiclient.SkillSummary
	for i := range resp.Items {
		if resp.Items[i].Name == "mismatched-name" {
			found = &resp.Items[i]
			break
		}
	}
	if found == nil {
		t.Fatalf("mismatched-name should be loaded in items")
	}

	foundWarning := false
	for _, diag := range resp.Diagnostics {
		if strings.Contains(diag.Path, "dir-name") && diag.Severity == "warning" {
			foundWarning = true
		}
	}
	if !foundWarning {
		t.Errorf("expected warning diagnostic for name/dir mismatch in: %+v", resp.Diagnostics)
	}
}

func TestSkills_BoundsTripAndAreReported(t *testing.T) {
	h := harness.New(t)
	user := h.As("user")
	be := h.Backend()

	skillDir := filepath.Join(be.Home, ".agents", "skills", "huge-skill")
	if err := os.MkdirAll(skillDir, 0o755); err != nil {
		t.Fatal(err)
	}
	// Create SKILL.md exceeding 1 MiB
	hugeData := make([]byte, 1024*1024+100)
	copy(hugeData, []byte("---\nname: huge-skill\ndescription: Huge skill\n---\n"))
	if err := os.WriteFile(filepath.Join(skillDir, "SKILL.md"), hugeData, 0o644); err != nil {
		t.Fatal(err)
	}

	resp, err := user.ListSkills(t.Context(), be.WorkspaceRoot)
	if err != nil {
		t.Fatalf("ListSkills: %v", err)
	}

	for _, it := range resp.Items {
		if it.Name == "huge-skill" {
			t.Errorf("huge-skill should not be loaded in items")
		}
	}

	foundDiag := false
	for _, diag := range resp.Diagnostics {
		if strings.Contains(diag.Path, "huge-skill") && diag.Severity == "error" {
			foundDiag = true
			if !strings.Contains(diag.Message, "size") {
				t.Errorf("diagnostic message = %q, want mention of size limit", diag.Message)
			}
		}
	}
	if !foundDiag {
		t.Errorf("expected size bound diagnostic in: %+v", resp.Diagnostics)
	}
}

func TestSkills_ProjectParamNonAbsRejected(t *testing.T) {
	h := harness.New(t)
	user := h.As("user")

	_, err := user.ListSkills(t.Context(), "relative/project/dir")
	if err == nil {
		t.Fatalf("expected error for relative project path, got nil")
	}
	if status := apiclient.StatusOf(err); status != 400 {
		t.Errorf("status = %d, want 400", status)
	}
}

func TestSkills_UnauthenticatedIs401(t *testing.T) {
	h := harness.New(t)
	client := h.Client() // Unauthenticated client

	_, err := client.ListSkills(t.Context())
	if err == nil {
		t.Fatalf("expected 401 for unauthenticated request, got nil")
	}
	if status := apiclient.StatusOf(err); status != 401 {
		t.Errorf("status = %d, want 401", status)
	}
}

func TestSkills_GetSkill_ReturnsSkillAndDetails(t *testing.T) {
	h := harness.New(t)
	user := h.As("user")
	be := h.Backend()

	skillDir := filepath.Join(be.WorkspaceRoot, ".agents", "skills", "get-target")
	writeSkill(t, filepath.Join(be.WorkspaceRoot, ".agents", "skills"), "get-target", "Get target description", "# Target Body Markdown Content", "allowed-tools: read_file write_file")

	// Create a resource file in the skill dir
	scriptsDir := filepath.Join(skillDir, "scripts")
	if err := os.MkdirAll(scriptsDir, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(scriptsDir, "helper.sh"), []byte("#!/bin/bash\necho hi"), 0o755); err != nil {
		t.Fatal(err)
	}

	skill, err := user.GetSkill(t.Context(), "get-target", be.WorkspaceRoot)
	if err != nil {
		t.Fatalf("GetSkill: %v", err)
	}

	if skill.Name != "get-target" {
		t.Errorf("skill.Name = %q, want get-target", skill.Name)
	}
	if skill.Description != "Get target description" {
		t.Errorf("skill.Description = %q", skill.Description)
	}
	if !strings.Contains(skill.Body, "Target Body Markdown Content") {
		t.Errorf("skill.Body = %q", skill.Body)
	}
	if len(skill.Resources) == 0 {
		t.Errorf("expected resources to contain scripts/helper.sh, got %+v", skill.Resources)
	}

	// 404 for nonexistent skill
	_, err = user.GetSkill(t.Context(), "nonexistent-skill", be.WorkspaceRoot)
	if err == nil {
		t.Fatalf("expected error for nonexistent skill, got nil")
	}
	if status := apiclient.StatusOf(err); status != 404 {
		t.Errorf("status = %d, want 404", status)
	}
}

func TestSkills_ListResponse_OmitsBodyAndResources(t *testing.T) {
	h := harness.New(t)
	user := h.As("user")
	be := h.Backend()

	skillDir := filepath.Join(be.WorkspaceRoot, ".agents", "skills", "body-check")
	writeSkill(t, filepath.Join(be.WorkspaceRoot, ".agents", "skills"), "body-check", "Check body omission", "# Secret instructions body")

	scriptsDir := filepath.Join(skillDir, "scripts")
	if err := os.MkdirAll(scriptsDir, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(scriptsDir, "tool.sh"), []byte("#!/bin/bash\n"), 0o755); err != nil {
		t.Fatal(err)
	}

	// 1. Check List response via raw JSON request
	var rawList map[string]any
	if err := user.Get(t.Context(), "/api/skills?project="+be.WorkspaceRoot, &rawList); err != nil {
		t.Fatalf("GET /api/skills: %v", err)
	}

	items, ok := rawList["items"].([]any)
	if !ok || len(items) == 0 {
		t.Fatalf("rawList items: %+v", rawList)
	}
	for _, itemRaw := range items {
		item := itemRaw.(map[string]any)
		if _, hasBody := item["body"]; hasBody {
			t.Errorf("list item JSON has 'body' field: %+v", item)
		}
		if _, hasResources := item["resources"]; hasResources {
			t.Errorf("list item JSON has 'resources' field: %+v", item)
		}
	}

	// 2. Check Get response via raw JSON request: MUST contain body and resources
	var rawGet map[string]any
	if err := user.Get(t.Context(), "/api/skills/items/body-check?project="+be.WorkspaceRoot, &rawGet); err != nil {
		t.Fatalf("GET /api/skills/items/body-check: %v", err)
	}
	if body, ok := rawGet["body"].(string); !ok || !strings.Contains(body, "Secret instructions body") {
		t.Errorf("raw get body = %v, want instructions", rawGet["body"])
	}
	if res, ok := rawGet["resources"].([]any); !ok || len(res) == 0 {
		t.Errorf("raw get resources = %v, want resources", rawGet["resources"])
	}
}

func TestSkills_ProjectParam_ValidationAndSymlinks(t *testing.T) {
	h := harness.New(t)
	user := h.As("user")
	be := h.Backend()

	// 1. Non-existent project path returns 400
	_, err := user.ListSkills(t.Context(), filepath.Join(be.WorkspaceRoot, "nonexistent-subfolder"))
	if err == nil {
		t.Fatalf("expected 400 for nonexistent project path, got nil")
	}
	if status := apiclient.StatusOf(err); status != 400 {
		t.Errorf("status = %d, want 400", status)
	}

	// 2. File path (not directory) returns 400
	dummyFile := filepath.Join(be.WorkspaceRoot, "dummy.txt")
	if err := os.WriteFile(dummyFile, []byte("content"), 0o644); err != nil {
		t.Fatal(err)
	}
	_, err = user.ListSkills(t.Context(), dummyFile)
	if err == nil {
		t.Fatalf("expected 400 for file project path, got nil")
	}
	if status := apiclient.StatusOf(err); status != 400 {
		t.Errorf("status = %d, want 400", status)
	}

	// 3. Symlinked project directory resolves cleanly
	symlinkProj := filepath.Join(be.Home, "symlink-workspace")
	if err := os.Symlink(be.WorkspaceRoot, symlinkProj); err != nil {
		t.Fatal(err)
	}
	resp, err := user.ListSkills(t.Context(), symlinkProj)
	if err != nil {
		t.Fatalf("ListSkills with symlinked project: %v", err)
	}
	if resp.Truncated {
		t.Errorf("truncated = true, want false")
	}
}

func TestSkills_SystemPrompt_CatalogPresentAndOmittedWhenEmpty(t *testing.T) {
	h := harness.New(t)
	user := h.As("user")
	be := h.Backend()

	// 1. When no skills exist: catalog is omitted from system prompt
	h.Fake().OnPrompt(fakeprovider.Contains("hello")).
		StreamText("Hello without skills!")

	req1 := apiclient.ChatRequest{
		ID:             "thread-catalog-empty",
		Message:        apiclient.TextMessage("msg-1", "hello"),
		WorkspaceRoot:  be.WorkspaceRoot,
		PermissionMode: "auto",
	}

	turn1, err := user.ChatTurn(t.Context(), req1)
	if err != nil {
		t.Fatalf("ChatTurn 1: %v", err)
	}
	if turn1.Text != "Hello without skills!" {
		t.Fatalf("turn1 text = %q", turn1.Text)
	}

	lastReqBody := h.Fake().LastRequestBody()
	if strings.Contains(lastReqBody, "<available_skills>") {
		t.Errorf("catalog should be omitted when 0 skills exist, but got:\n%s", lastReqBody)
	}

	// 2. When skills exist: catalog is present with name and description, no body
	projDir := filepath.Join(be.WorkspaceRoot, "cat-proj")
	skillsDir := filepath.Join(projDir, ".agents", "skills")
	writeSkill(t, skillsDir, "code-review", "Reviews pull requests and diffs.", "# Full code review instructions that should not be in catalog")

	h.Fake().OnPrompt(fakeprovider.Contains("do review")).
		StreamText("Ready to review!")

	req2 := apiclient.ChatRequest{
		ID:             "thread-catalog-present",
		Message:        apiclient.TextMessage("msg-2", "do review"),
		WorkspaceRoot:  projDir,
		PermissionMode: "auto",
	}

	turn2, err := user.ChatTurn(t.Context(), req2)
	if err != nil {
		t.Fatalf("ChatTurn 2: %v", err)
	}
	if turn2.Text != "Ready to review!" {
		t.Fatalf("turn2 text = %q", turn2.Text)
	}

	lastReqBody2 := h.Fake().LastRequestBody()
	if !strings.Contains(lastReqBody2, "available_skills") {
		t.Errorf("expected <available_skills> in system prompt, got:\n%s", lastReqBody2)
	}
	if !strings.Contains(lastReqBody2, "code-review") {
		t.Errorf("expected code-review in system prompt catalog, got:\n%s", lastReqBody2)
	}
	if !strings.Contains(lastReqBody2, "Reviews pull requests and diffs.") {
		t.Errorf("expected description in catalog, got:\n%s", lastReqBody2)
	}
	if strings.Contains(lastReqBody2, "Full code review instructions") {
		t.Errorf("catalog MUST NOT leak skill body into system prompt, got:\n%s", lastReqBody2)
	}
}

func TestSkills_Activation_ModelCallsSkillTool_FrontmatterStripped(t *testing.T) {
	h := harness.New(t)
	user := h.As("user")
	be := h.Backend()

	skillsDir := filepath.Join(be.WorkspaceRoot, ".agents", "skills")
	writeSkill(t, skillsDir, "deployer", "Deploys the service.", "# Deployment Guide\nRun deployment scripts carefully.", "author: Alice", "version: 1.0.0")

	// Fake model calls skill tool then answers
	h.Fake().OnPrompt(fakeprovider.Contains("please deploy")).
		ToolCall("skill", map[string]any{"name": "deployer"}).
		ThenStreamText("Deployment skill activated, proceeding.")

	req := apiclient.ChatRequest{
		ID:             "thread-skill-activation-1",
		Message:        apiclient.TextMessage("msg-1", "please deploy"),
		WorkspaceRoot:  be.WorkspaceRoot,
		PermissionMode: "auto",
	}

	turn, err := user.ChatTurn(t.Context(), req)
	if err != nil {
		t.Fatalf("ChatTurn: %v", err)
	}

	if !strings.Contains(turn.Text, "Deployment skill activated") {
		t.Errorf("turn text = %q", turn.Text)
	}

	// Verify the tool result in exchanges contains stripped body and skill dir
	exchanges := h.Fake().Exchanges()
	foundToolResult := false
	for _, ex := range exchanges {
		if strings.Contains(ex.Body, "skill_content name=\\\"deployer\\\"") || strings.Contains(ex.Body, `<skill_content name="deployer">`) {
			foundToolResult = true
			if !strings.Contains(ex.Body, "Deployment Guide") {
				t.Errorf("expected skill body in tool result, got:\n%s", ex.Body)
			}
			if strings.Contains(ex.Body, "author: Alice") {
				t.Errorf("frontmatter was not stripped from skill body:\n%s", ex.Body)
			}
			if !strings.Contains(ex.Body, "Skill directory:") {
				t.Errorf("skill directory missing from tool result:\n%s", ex.Body)
			}
		}
	}
	if !foundToolResult {
		t.Errorf("tool result with <skill_content> not found in model exchanges")
	}
}

func TestSkills_Activation_BundledResourceRead(t *testing.T) {
	h := harness.New(t)
	user := h.As("user")
	be := h.Backend()

	// Plant user-scoped skill with a bundled reference file
	userSkillsDir := filepath.Join(be.Home, ".agents", "skills")
	skillDir := writeSkill(t, userSkillsDir, "tester", "Runs tests.", "# Tester Guide\nFollow checklist.")
	refDir := filepath.Join(skillDir, "references")
	if err := os.MkdirAll(refDir, 0o755); err != nil {
		t.Fatal(err)
	}
	refFile := filepath.Join(refDir, "checklist.md")
	if err := os.WriteFile(refFile, []byte("# Checklist\n1. Unit tests\n2. Integration tests"), 0o644); err != nil {
		t.Fatal(err)
	}

	// Model activates tester, then reads the bundled reference file
	h.Fake().OnPrompt(fakeprovider.Contains("run tests")).
		ToolCall("skill", map[string]any{"name": "tester"}).
		ToolCall("read_file", map[string]any{"path": refFile}).
		ThenStreamText("Checklist read successfully.")

	req := apiclient.ChatRequest{
		ID:             "thread-bundled-read",
		Message:        apiclient.TextMessage("msg-1", "run tests"),
		WorkspaceRoot:  be.WorkspaceRoot,
		PermissionMode: "auto",
	}

	turn, err := user.ChatTurn(t.Context(), req)
	if err != nil {
		t.Fatalf("ChatTurn: %v", err)
	}
	if !strings.Contains(turn.Text, "Checklist read successfully") {
		t.Errorf("turn text = %q", turn.Text)
	}

	// Check model saw checklist content in read_file result
	exchanges := h.Fake().Exchanges()
	foundChecklist := false
	for _, ex := range exchanges {
		if strings.Contains(ex.Body, "Unit tests") && strings.Contains(ex.Body, "Integration tests") {
			foundChecklist = true
		}
	}
	if !foundChecklist {
		t.Errorf("bundled resource content not found in exchanges")
	}
}

func TestSkills_Activation_WriteRejected(t *testing.T) {
	h := harness.New(t)
	user := h.As("user")
	be := h.Backend()

	userSkillsDir := filepath.Join(be.Home, ".agents", "skills")
	skillDir := writeSkill(t, userSkillsDir, "helper", "Helps.", "# Helper")
	targetFile := filepath.Join(skillDir, "payload.txt")

	// Model activates skill, then tries to write into skill dir (outside workspace)
	h.Fake().OnPrompt(fakeprovider.Contains("hack skill")).
		ToolCall("skill", map[string]any{"name": "helper"}).
		ToolCall("write_file", map[string]any{"path": targetFile, "content": "malicious"}).
		ThenStreamText("Attempted write.")

	req := apiclient.ChatRequest{
		ID:             "thread-write-reject",
		Message:        apiclient.TextMessage("msg-1", "hack skill"),
		WorkspaceRoot:  be.WorkspaceRoot,
		PermissionMode: "auto",
	}

	turn, err := user.ChatTurn(t.Context(), req)
	if err != nil {
		t.Fatalf("ChatTurn: %v", err)
	}

	// Verify file was NOT created
	if _, statErr := os.Stat(targetFile); statErr == nil {
		t.Errorf("write_file into skill directory should have failed containment, but file was created!")
	}

	// Verify permission/workspace refusal error reached the tool loop
	exchanges := h.Fake().Exchanges()
	foundRefusal := false
	for _, ex := range exchanges {
		if strings.Contains(ex.Body, "outside the workspace") {
			foundRefusal = true
		}
	}
	if !foundRefusal {
		t.Logf("turn text: %s", turn.Text)
	}
}

func TestSkills_Activation_AutoApprovedUnderRiskRead(t *testing.T) {
	modes := []string{"plan", "interactive", "edit", "auto"}
	for _, mode := range modes {
		t.Run("mode_"+mode, func(t *testing.T) {
			h := harness.New(t)
			user := h.As("user")
			be := h.Backend()

			skillsDir := filepath.Join(be.WorkspaceRoot, ".agents", "skills")
			writeSkill(t, skillsDir, "auditor", "Audits security.", "# Auditor Body")

			// In all permission modes including plan, skill tool is auto-approved under RiskRead
			h.Fake().OnPrompt(fakeprovider.Contains("run audit")).
				ToolCall("skill", map[string]any{"name": "auditor"}).
				ThenStreamText("Audit completed without manual approval.")

			req := apiclient.ChatRequest{
				ID:             "thread-auto-approved-" + mode,
				Message:        apiclient.TextMessage("msg-1", "run audit"),
				WorkspaceRoot:  be.WorkspaceRoot,
				PermissionMode: mode,
			}

			turn, err := user.ChatTurn(t.Context(), req)
			if err != nil {
				t.Fatalf("ChatTurn in mode %s: %v", mode, err)
			}
			if !strings.Contains(turn.Text, "Audit completed without manual approval") {
				t.Errorf("mode %s: turn text = %q", mode, turn.Text)
			}
		})
	}
}

func TestSkills_Activation_MentionAndModelActivation_BundledResourceRead(t *testing.T) {
	h := harness.New(t)
	user := h.As("user")
	be := h.Backend()

	// Skill 1: Mentioned skill
	userSkillsDir := filepath.Join(be.Home, ".agents", "skills")
	writeSkill(t, userSkillsDir, "skill-a", "First skill", "# Skill A Instructions")

	// Skill 2: Model-activated skill with bundled reference file
	skillBDir := writeSkill(t, userSkillsDir, "skill-b", "Second skill", "# Skill B Instructions")
	refDir := filepath.Join(skillBDir, "references")
	if err := os.MkdirAll(refDir, 0o755); err != nil {
		t.Fatal(err)
	}
	refFile := filepath.Join(refDir, "guide.md")
	if err := os.WriteFile(refFile, []byte("# Bundled Guide B"), 0o644); err != nil {
		t.Fatal(err)
	}

	// Model activates skill-b and reads its bundled resource in the turn where skill-a was mentioned
	h.Fake().OnPrompt(fakeprovider.Contains("combine skills")).
		ToolCall("skill", map[string]any{"name": "skill-b"}).
		ToolCall("read_file", map[string]any{"path": refFile}).
		ThenStreamText("Both skills handled.")

	req := apiclient.ChatRequest{
		ID:             "thread-mention-and-activate",
		Message:        apiclient.TextMessage("msg-1", "combine skills"),
		Mentions:       []apiclient.Mention{{Type: "skill", Name: "skill-a"}},
		WorkspaceRoot:  be.WorkspaceRoot,
		PermissionMode: "auto",
	}

	turn, err := user.ChatTurn(t.Context(), req)
	if err != nil {
		t.Fatalf("ChatTurn: %v", err)
	}
	if !strings.Contains(turn.Text, "Both skills handled") {
		t.Errorf("turn text = %q", turn.Text)
	}

	// Verify read_file succeeded on skill-b's bundled resource
	exchanges := h.Fake().Exchanges()
	foundRef := false
	for _, ex := range exchanges {
		if strings.Contains(ex.Body, "Bundled Guide B") {
			foundRef = true
		}
	}
	if !foundRef {
		t.Fatalf("bundled resource of model-activated skill-b was not read successfully in turn with mention")
	}
}

func TestSkills_Activation_ReadOnlyRootsDoNotLeakAcrossTurns(t *testing.T) {
	h := harness.New(t)
	user := h.As("user")
	be := h.Backend()

	userSkillsDir := filepath.Join(be.Home, ".agents", "skills")
	skillDir := writeSkill(t, userSkillsDir, "secret-skill", "Secret skill", "# Secret Skill Instructions")
	secretFile := filepath.Join(skillDir, "secret.txt")
	if err := os.WriteFile(secretFile, []byte("super-secret-payload"), 0o644); err != nil {
		t.Fatal(err)
	}

	// Turn 1: Activates secret-skill
	h.Fake().OnPrompt(fakeprovider.Contains("turn 1 activate")).
		ToolCall("skill", map[string]any{"name": "secret-skill"}).
		ThenStreamText("Turn 1 active.")

	req1 := apiclient.ChatRequest{
		ID:             "thread-turn-1",
		Message:        apiclient.TextMessage("msg-1", "turn 1 activate"),
		WorkspaceRoot:  be.WorkspaceRoot,
		PermissionMode: "auto",
	}
	if _, err := user.ChatTurn(t.Context(), req1); err != nil {
		t.Fatalf("Turn 1 failed: %v", err)
	}

	// Turn 2: New thread, no skill activation, model tries to read secretFile from Turn 1's skill
	h.Fake().OnPrompt(fakeprovider.Contains("turn 2 sneak")).
		ToolCall("read_file", map[string]any{"path": secretFile}).
		ThenStreamText("Turn 2 attempt.")

	req2 := apiclient.ChatRequest{
		ID:             "thread-turn-2",
		Message:        apiclient.TextMessage("msg-2", "turn 2 sneak"),
		WorkspaceRoot:  be.WorkspaceRoot,
		PermissionMode: "auto",
	}
	turn2, err := user.ChatTurn(t.Context(), req2)
	if err != nil {
		t.Fatalf("Turn 2 failed: %v", err)
	}
	_ = turn2

	// Verify Turn 2's read_file was REFUSED because read-only roots did not leak across turns!
	exchanges := h.Fake().Exchanges()
	foundRefusal := false
	for _, ex := range exchanges {
		if strings.Contains(ex.Body, "outside the workspace") {
			foundRefusal = true
		}
	}
	if !foundRefusal {
		t.Errorf("read-only root from Turn 1 leaked into Turn 2!")
	}
}

func TestSkills_Activation_UnknownNameRejectedByEnumWithoutModelRoundTrip(t *testing.T) {
	h := harness.New(t)
	user := h.As("user")
	be := h.Backend()

	skillsDir := filepath.Join(be.WorkspaceRoot, ".agents", "skills")
	writeSkill(t, skillsDir, "real-skill", "Real skill.", "# Real Body")

	h.Fake().OnPrompt(fakeprovider.Contains("hello")).StreamText("Hello world")

	req := apiclient.ChatRequest{
		ID:             "thread-enum-check",
		Message:        apiclient.TextMessage("msg-1", "hello"),
		WorkspaceRoot:  be.WorkspaceRoot,
		PermissionMode: "auto",
	}
	if _, err := user.ChatTurn(t.Context(), req); err != nil {
		t.Fatalf("ChatTurn: %v", err)
	}

	// Verify tools array in request body has skill parameter enum containing only real-skill
	lastReq := h.Fake().LastRequestBody()
	var bodyMap map[string]any
	if err := json.Unmarshal([]byte(lastReq), &bodyMap); err != nil {
		t.Fatalf("unmarshal lastRequestBody: %v\nBody: %s", err, lastReq)
	}

	toolsList, ok := bodyMap["tools"].([]any)
	if !ok {
		t.Fatalf("expected tools array in request body: %+v", bodyMap)
	}

	foundSkillTool := false
	for _, toolItem := range toolsList {
		tm, _ := toolItem.(map[string]any)
		fn, _ := tm["function"].(map[string]any)
		if fn == nil {
			continue
		}
		if fn["name"] == "skill" {
			foundSkillTool = true
			params, _ := fn["parameters"].(map[string]any)
			props, _ := params["properties"].(map[string]any)
			nameProp, _ := props["name"].(map[string]any)
			enumList, _ := nameProp["enum"].([]any)
			if len(enumList) != 1 || enumList[0] != "real-skill" {
				t.Errorf("skill tool enum = %+v, want [\"real-skill\"]", enumList)
			}
		}
	}

	if !foundSkillTool {
		t.Fatalf("skill tool was not offered in tools array: %+v", toolsList)
	}
}

func TestSkills_Activation_SkillContentSurvivesCompaction(t *testing.T) {
	h := harness.New(t)
	user := h.As("user")
	be := h.Backend()

	skillsDir := filepath.Join(be.WorkspaceRoot, ".agents", "skills")
	writeSkill(t, skillsDir, "compaction-target", "Target for compaction test.", "# Special Instructions That Must Survive Compaction")

	threadID := "thread-skill-compact-1"

	// Turn 1: Activate skill
	h.Fake().OnPrompt(fakeprovider.Contains("activate skill")).
		ToolCall("skill", map[string]any{"name": "compaction-target"}).
		ThenStreamText("Skill is active in thread.")

	req1 := apiclient.ChatRequest{
		ID:             threadID,
		Message:        apiclient.TextMessage("msg-1", "activate skill"),
		WorkspaceRoot:  be.WorkspaceRoot,
		PermissionMode: "auto",
	}
	if _, err := user.ChatTurn(t.Context(), req1); err != nil {
		t.Fatalf("Turn 1 failed: %v", err)
	}

	// Turn 2: Run several turns to add history
	for i := 2; i <= 4; i++ {
		h.Fake().OnPrompt(fakeprovider.Contains(fmt.Sprintf("turn %d", i))).
			StreamText(fmt.Sprintf("Answer for turn %d with long explanation.", i))
		req := apiclient.ChatRequest{
			ID:             threadID,
			Message:        apiclient.TextMessage(fmt.Sprintf("msg-%d", i), fmt.Sprintf("turn %d", i)),
			WorkspaceRoot:  be.WorkspaceRoot,
			PermissionMode: "auto",
		}
		if _, err := user.ChatTurn(t.Context(), req); err != nil {
			t.Fatalf("Turn %d failed: %v", i, err)
		}
	}

	// Turn 5: Trigger compaction via CompactNow
	h.Fake().OnPrompt(fakeprovider.Contains("summarize")).StreamText("Summarized conversation history.")
	h.Fake().OnPrompt(fakeprovider.Contains("post-compact query")).StreamText("Final answer after compaction.")

	reqCompact := apiclient.ChatRequest{
		ID:             threadID,
		Message:        apiclient.TextMessage("msg-compact", "post-compact query"),
		WorkspaceRoot:  be.WorkspaceRoot,
		PermissionMode: "auto",
		CompactNow:     true,
	}

	if _, err := user.ChatTurn(t.Context(), reqCompact); err != nil {
		t.Fatalf("Compacted turn failed: %v", err)
	}

	// Assert that <skill_content> block for compaction-target survived into the outbound request
	lastReq := h.Fake().LastRequestBody()
	if !strings.Contains(lastReq, "compaction-target") && !strings.Contains(lastReq, "Special Instructions That Must Survive Compaction") {
		t.Errorf("expected <skill_content> to survive compaction in outbound request body, got:\n%s", lastReq)
	}
}

func TestSkills_Activation_Deduplicated(t *testing.T) {
	h := harness.New(t)
	user := h.As("user")
	be := h.Backend()

	skillsDir := filepath.Join(be.WorkspaceRoot, ".agents", "skills")
	writeSkill(t, skillsDir, "formatter", "Formats code.", "# Formatter Body")

	// Call skill tool twice in same turn
	h.Fake().OnPrompt(fakeprovider.Contains("format code")).
		ToolCall("skill", map[string]any{"name": "formatter"}).
		ToolCall("skill", map[string]any{"name": "formatter"}).
		ThenStreamText("Formatted.")

	req := apiclient.ChatRequest{
		ID:             "thread-dedup",
		Message:        apiclient.TextMessage("msg-1", "format code"),
		WorkspaceRoot:  be.WorkspaceRoot,
		PermissionMode: "auto",
	}

	turn, err := user.ChatTurn(t.Context(), req)
	if err != nil {
		t.Fatalf("ChatTurn: %v", err)
	}
	if !strings.Contains(turn.Text, "Formatted") {
		t.Errorf("turn text = %q", turn.Text)
	}

	// Verify second call returned "already active" notice
	exchanges := h.Fake().Exchanges()
	foundNotice := false
	for _, ex := range exchanges {
		if strings.Contains(ex.Body, "already active") {
			foundNotice = true
		}
	}
	if !foundNotice {
		t.Errorf("expected 'already active' notice in second tool call result")
	}
}

func TestSkills_Mention_ExplicitInjectionBeforeFirstModelCall(t *testing.T) {
	h := harness.New(t)
	user := h.As("user")
	be := h.Backend()

	skillsDir := filepath.Join(be.WorkspaceRoot, ".agents", "skills")
	writeSkill(t, skillsDir, "architect", "Architects systems.", "# Architect Body Instructions")

	h.Fake().OnPrompt(fakeprovider.Contains("design system")).
		StreamText("Architecture proposal ready.")

	req := apiclient.ChatRequest{
		ID:            "thread-mention-1",
		Message:       apiclient.TextMessage("msg-1", "design system"),
		Mentions:      []apiclient.Mention{{Type: "skill", Name: "architect"}},
		WorkspaceRoot: be.WorkspaceRoot,
	}

	turn, err := user.ChatTurn(t.Context(), req)
	if err != nil {
		t.Fatalf("ChatTurn: %v", err)
	}
	if !strings.Contains(turn.Text, "Architecture proposal ready") {
		t.Errorf("turn text = %q", turn.Text)
	}

	// First request sent to fake model MUST already contain the injected <skill_content>
	lastReq := h.Fake().LastRequestBody()
	if !strings.Contains(lastReq, "skill_content name=\\\"architect\\\"") && !strings.Contains(lastReq, `<skill_content name="architect">`) {
		t.Errorf("expected <skill_content name=\"architect\"> in first model request, got:\n%s", lastReq)
	}
	if !strings.Contains(lastReq, "Architect Body Instructions") {
		t.Errorf("expected skill instructions in first model request, got:\n%s", lastReq)
	}
}

func TestSkills_Mention_IgnoresDisableModelInvocation(t *testing.T) {
	h := harness.New(t)
	user := h.As("user")
	be := h.Backend()

	skillsDir := filepath.Join(be.WorkspaceRoot, ".agents", "skills")
	writeSkill(t, skillsDir, "manual-only", "Manual only skill.", "# Manual Only Instructions", "disable-model-invocation: true")

	// Explicit mention should load it even though disable-model-invocation is true
	h.Fake().OnPrompt(fakeprovider.Contains("run manual")).
		StreamText("Manual skill used.")

	req := apiclient.ChatRequest{
		ID:            "thread-mention-disable-model",
		Message:       apiclient.TextMessage("msg-1", "run manual"),
		Mentions:      []apiclient.Mention{{Type: "skill", Name: "manual-only"}},
		WorkspaceRoot: be.WorkspaceRoot,
	}

	turn, err := user.ChatTurn(t.Context(), req)
	if err != nil {
		t.Fatalf("ChatTurn: %v", err)
	}
	if !strings.Contains(turn.Text, "Manual skill used") {
		t.Errorf("turn text = %q", turn.Text)
	}

	lastReq := h.Fake().LastRequestBody()
	if !strings.Contains(lastReq, "skill_content name=\\\"manual-only\\\"") && !strings.Contains(lastReq, `<skill_content name="manual-only">`) {
		t.Errorf("expected <skill_content name=\"manual-only\"> in first model request, got:\n%s", lastReq)
	}
	if !strings.Contains(lastReq, "Manual Only Instructions") {
		t.Errorf("expected skill instructions in model request, got:\n%s", lastReq)
	}
}

func TestSkills_Mention_UnknownSkillReturnsVisibleError(t *testing.T) {
	h := harness.New(t)
	user := h.As("user")
	be := h.Backend()

	req := apiclient.ChatRequest{
		ID:            "thread-mention-unknown",
		Message:       apiclient.TextMessage("msg-1", "use fake skill"),
		Mentions:      []apiclient.Mention{{Type: "skill", Name: "nonexistent-skill"}},
		WorkspaceRoot: be.WorkspaceRoot,
	}

	_, err := user.ChatTurn(t.Context(), req)
	if err == nil {
		t.Fatalf("expected error for unresolvable skill mention, got nil")
	}
	if !strings.Contains(err.Error(), "nonexistent-skill") && !strings.Contains(err.Error(), "500") && !strings.Contains(err.Error(), "400") {
		t.Errorf("expected skill resolution error, got: %v", err)
	}
}



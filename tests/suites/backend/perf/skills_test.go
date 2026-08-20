package perf_test

import (
	"fmt"
	"os"
	"path/filepath"
	"testing"
	"time"

	"amiro/tests/harness"
)

// TestPerf_SkillsDiscoveryOver200Skills benchmarks discovery scanning of a large (~200 skill) tree.
// Tagged "slow" per perf budget conventions.
func TestPerf_SkillsDiscoveryOver200Skills(t *testing.T) {
	h := harness.New(t, harness.Tags("slow"))
	user := h.As("user")
	be := h.Backend()

	// Seed 200 skills in the project workspace .agents/skills/
	skillsDir := filepath.Join(be.WorkspaceRoot, ".agents", "skills")
	if err := os.MkdirAll(skillsDir, 0o755); err != nil {
		t.Fatalf("mkdir %s: %v", skillsDir, err)
	}

	skillContent := []byte("---\nname: %s\ndescription: Performance test benchmark skill\n---\n# Perf Skill Body\nInstructions for perf benchmark.\n")
	for i := 0; i < 200; i++ {
		name := fmt.Sprintf("perf-skill-%03d", i)
		dir := filepath.Join(skillsDir, name)
		if err := os.MkdirAll(dir, 0o755); err != nil {
			t.Fatalf("mkdir %s: %v", dir, err)
		}
		data := fmt.Appendf(nil, string(skillContent), name)
		if err := os.WriteFile(filepath.Join(dir, "SKILL.md"), data, 0o644); err != nil {
			t.Fatalf("writeFile: %v", err)
		}
	}

	// Measure discovery scan latency over HTTP API
	began := time.Now()
	resp, err := user.ListSkills(t.Context(), be.WorkspaceRoot)
	if err != nil {
		t.Fatalf("ListSkills: %v", err)
	}
	elapsed := time.Since(began)

	if len(resp.Items) != 200 {
		t.Fatalf("discovered %d skills, want 200", len(resp.Items))
	}

	recordDuration(h, budgetSkillsDiscovery, elapsed, limitSkillsDiscovery, "200 skills scanned in project .agents/skills")
}

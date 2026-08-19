package meta_test

import (
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"testing"

	"amiro/tests/harness"
)

var forbiddenWaitPatterns = []*regexp.Regexp{
	regexp.MustCompile(`page\.waitForTimeout\s*\(`),
	regexp.MustCompile(`(?:\b|window\.)setTimeout\s*\(`),
	regexp.MustCompile(`(?:\b|window\.)setInterval\s*\(`),
	regexp.MustCompile(`waitFor\s*\(\s*\d+\s*\)`),
}

// scanFileForHardcodedWaits scans a source file content for forbidden sleep/wait patterns.
func scanFileForHardcodedWaits(content string) []string {
	var matches []string
	lines := strings.Split(content, "\n")
	for lineIdx, line := range lines {
		// Ignore comment lines
		trimmed := strings.TrimSpace(line)
		if strings.HasPrefix(trimmed, "//") || strings.HasPrefix(trimmed, "/*") || strings.HasPrefix(trimmed, "*") {
			continue
		}
		for _, re := range forbiddenWaitPatterns {
			if re.MatchString(line) {
				matches = append(matches, fmt.Sprintf("line %d: %s", lineIdx+1, strings.TrimSpace(line)))
			}
		}
	}
	return matches
}

// TestUISpecs_DoNotUseHardcodedWaits is Criterion 8's meta guard.
//
// Hard-coded waits (page.waitForTimeout, setTimeout, fixed sleeps) are flaky
// anti-patterns that hide race conditions. Playwright provides predicate-based
// auto-waiting, expect(...) assertions, and event-based synchronisation.
func TestUISpecs_DoNotUseHardcodedWaits(t *testing.T) {
	h := harness.New(t, harness.NoBackend(), harness.Tags("smoke"))

	specsDir := filepath.Join(h.BaseDir, "ui", "specs")
	if _, err := os.Stat(specsDir); os.IsNotExist(err) {
		t.Fatalf("specs directory does not exist: %s", specsDir)
	}

	var findings []string
	specCount := 0

	err := filepath.WalkDir(specsDir, func(path string, d os.DirEntry, err error) error {
		if err != nil {
			return err
		}
		if d.IsDir() {
			return nil
		}
		if !strings.HasSuffix(d.Name(), ".spec.ts") && !strings.HasSuffix(d.Name(), ".spec.tsx") {
			return nil
		}
		specCount++
		data, readErr := os.ReadFile(path)
		if readErr != nil {
			return readErr
		}
		matches := scanFileForHardcodedWaits(string(data))
		for _, m := range matches {
			rel, _ := filepath.Rel(h.BaseDir, path)
			findings = append(findings, fmt.Sprintf("%s (%s)", rel, m))
		}
		return nil
	})

	if err != nil {
		t.Fatalf("walking %s: %v", specsDir, err)
	}

	if specCount == 0 {
		t.Fatalf("no spec files found under %s; guard is vacuous", specsDir)
	}

	if len(findings) > 0 {
		t.Fatalf("hardcoded waits found in UI specs:\n  %s\n\n"+
			"Use locator.waitFor(), expect(...), or data-state predicates instead of fixed timeouts.",
			strings.Join(findings, "\n  "))
	}

	t.Logf("Verified %d UI spec files: 0 hardcoded waits found.", specCount)
}

// TestUISpecs_GuardIsNonVacuous proves that the pattern matcher catches violations.
func TestUISpecs_GuardIsNonVacuous(t *testing.T) {
	snippets := []struct {
		code string
		want int
	}{
		{`await page.waitForTimeout(1000);`, 1},
		{`setTimeout(() => {}, 500);`, 1},
		{`window.setInterval(() => {}, 100);`, 1},
		{`await page.waitFor(500);`, 1},
		{`// page.waitForTimeout(1000) inside comment`, 0},
		{`await expect(page.locator('.bubble')).toBeVisible();`, 0},
	}

	for _, s := range snippets {
		matches := scanFileForHardcodedWaits(s.code)
		if len(matches) != s.want {
			t.Errorf("scanFileForHardcodedWaits(%q) = %d matches, want %d", s.code, len(matches), s.want)
		}
	}
}

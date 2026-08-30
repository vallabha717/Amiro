package rules

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestBuild_NoFileReturnsEmptyWithNoError(t *testing.T) {
	prompt, report := Build(t.TempDir())
	if prompt != "" {
		t.Fatalf("prompt = %q, want empty", prompt)
	}
	if report.Path != "" || report.Truncated {
		t.Fatalf("report = %+v, want zero value", report)
	}
}

func TestBuild_EmptyRootReturnsEmpty(t *testing.T) {
	prompt, report := Build("")
	if prompt != "" || report != (Report{}) {
		t.Fatalf("prompt=%q report=%+v, want both zero", prompt, report)
	}
}

func TestBuild_ReadsAGENTSMdAtRoot(t *testing.T) {
	root := t.TempDir()
	if err := os.WriteFile(filepath.Join(root, "AGENTS.md"), []byte("use pnpm for everything"), 0o644); err != nil {
		t.Fatalf("write AGENTS.md: %v", err)
	}

	prompt, report := Build(root)
	if !strings.Contains(prompt, "use pnpm for everything") {
		t.Fatalf("prompt = %q, want it to contain the file's content", prompt)
	}
	if report.Path != filepath.Join(root, "AGENTS.md") {
		t.Fatalf("report.Path = %q, want the root AGENTS.md", report.Path)
	}
	if report.Truncated {
		t.Fatal("report.Truncated = true for a short file")
	}
}

func TestBuild_FallsBackToDotAgentsAGENTSMd(t *testing.T) {
	root := t.TempDir()
	if err := os.MkdirAll(filepath.Join(root, ".agents"), 0o755); err != nil {
		t.Fatalf("mkdir .agents: %v", err)
	}
	if err := os.WriteFile(filepath.Join(root, ".agents", "AGENTS.md"), []byte("nested rules"), 0o644); err != nil {
		t.Fatalf("write .agents/AGENTS.md: %v", err)
	}

	prompt, report := Build(root)
	if !strings.Contains(prompt, "nested rules") {
		t.Fatalf("prompt = %q, want it to contain the nested file's content", prompt)
	}
	if report.Path != filepath.Join(root, ".agents", "AGENTS.md") {
		t.Fatalf("report.Path = %q, want the .agents/AGENTS.md fallback", report.Path)
	}
}

func TestBuild_RootAGENTSMdWinsOverDotAgentsFallback(t *testing.T) {
	root := t.TempDir()
	if err := os.WriteFile(filepath.Join(root, "AGENTS.md"), []byte("root wins"), 0o644); err != nil {
		t.Fatalf("write AGENTS.md: %v", err)
	}
	if err := os.MkdirAll(filepath.Join(root, ".agents"), 0o755); err != nil {
		t.Fatalf("mkdir .agents: %v", err)
	}
	if err := os.WriteFile(filepath.Join(root, ".agents", "AGENTS.md"), []byte("nested loses"), 0o644); err != nil {
		t.Fatalf("write .agents/AGENTS.md: %v", err)
	}

	prompt, _ := Build(root)
	if !strings.Contains(prompt, "root wins") || strings.Contains(prompt, "nested loses") {
		t.Fatalf("prompt = %q, want only the root AGENTS.md's content", prompt)
	}
}

func TestBuild_TruncatesPastCapWithANotice(t *testing.T) {
	root := t.TempDir()
	long := strings.Repeat("x", MaxRulesLen+500)
	if err := os.WriteFile(filepath.Join(root, "AGENTS.md"), []byte(long), 0o644); err != nil {
		t.Fatalf("write AGENTS.md: %v", err)
	}

	prompt, report := Build(root)
	if !report.Truncated {
		t.Fatal("report.Truncated = false for a file past MaxRulesLen")
	}
	if !strings.Contains(prompt, "truncated") {
		t.Fatalf("prompt = %q, want a visible truncation notice rather than a silent clip", prompt)
	}
}

func TestBuild_EmptyFileContributesNothing(t *testing.T) {
	root := t.TempDir()
	if err := os.WriteFile(filepath.Join(root, "AGENTS.md"), []byte("   \n  "), 0o644); err != nil {
		t.Fatalf("write AGENTS.md: %v", err)
	}

	prompt, _ := Build(root)
	if prompt != "" {
		t.Fatalf("prompt = %q, want empty for a whitespace-only file", prompt)
	}
}

package swebench

import (
	"context"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

// The end-to-end proof that this adapter measures what it claims to.
//
// Everything else in this package's tests is a unit test over a fixed string,
// which can only prove that the parser reads a log the test itself wrote. This
// runs the real thing: a real SWE-bench image, the instance's own eval script,
// the real patch pipeline. It is what distinguishes "the plumbing compiles"
// from "the plumbing works".
//
// It asserts both directions, because only one of them is worth much alone:
//
//   - the gold patch scores **resolved** -- proves the pipeline can actually
//     produce a pass, and that a green result is reachable at all;
//   - an empty patch scores **unresolved** -- proves the pass came from the
//     patch rather than from a scorer that says yes to anything. A benchmark
//     that only ever checked the first direction would report a perfect score
//     for an agent that did nothing.
//
// Opt-in, because it pulls a multi-gigabyte image and takes minutes:
//
//	SWEBENCH_INTEGRATION=1 go test ./internal/agent/eval/swebench -run Integration -timeout 30m
//
// Skipped rather than failed without it, so `go test ./...` stays hermetic and
// fast. A test that silently needs Docker is a test that reports green on
// every machine that cannot run it.
func TestIntegration_ScoresAGoldPatchResolvedAndAnEmptyPatchUnresolved(t *testing.T) {
	if os.Getenv("SWEBENCH_INTEGRATION") == "" {
		t.Skip("set SWEBENCH_INTEGRATION=1 to run against real Docker images")
	}

	ctx, cancel := context.WithTimeout(context.Background(), 25*time.Minute)
	defer cancel()

	if err := Available(ctx); err != nil {
		t.Skipf("docker unavailable: %v", err)
	}

	instances, err := LoadInstances(pinnedSubsetPath(t))
	if err != nil {
		t.Fatalf("load pinned subset: %v", err)
	}
	var in Instance
	for _, candidate := range instances {
		if candidate.ID == "astropy__astropy-12907" {
			in = candidate
		}
	}
	if in.ID == "" {
		t.Skip("astropy__astropy-12907 is not in the pinned subset")
	}

	// 1. Materialize, exactly as a run would.
	work := t.TempDir()
	checkout := filepath.Join(work, "checkout")
	if err := Materialize(ctx, in, checkout); err != nil {
		t.Fatalf("materialize: %v", err)
	}
	if _, err := os.Stat(filepath.Join(checkout, "astropy", "modeling", "separable.py")); err != nil {
		t.Fatalf("the materialized tree does not look like the repository: %v", err)
	}

	// 2. An untouched workspace must produce an empty patch and score
	//    unresolved. This is the direction that keeps the benchmark honest.
	empty, err := PatchFrom(ctx, checkout)
	if err != nil {
		t.Fatalf("patch from an untouched checkout: %v", err)
	}
	if strings.TrimSpace(empty) != "" {
		t.Fatalf("an untouched checkout produced a non-empty patch:\n%s", empty)
	}

	log, err := RunEval(ctx, in, empty)
	if err != nil {
		t.Fatalf("eval with an empty patch: %v", err)
	}
	resolved, why := Score(log, in.FailToPass, in.PassToPass)
	if resolved {
		t.Fatalf("an empty patch scored as RESOLVED -- the scorer accepts anything")
	}
	t.Logf("empty patch correctly unresolved: %v", why)

	// 3. The gold patch, applied the way an agent's edits would be: written
	//    into the workspace, then read back out by PatchFrom. Applying it with
	//    `git apply` here rather than handing the file straight to RunEval is
	//    deliberate -- it exercises the same read-the-workspace path a real
	//    run uses, rather than smuggling the patch past it.
	gold, err := os.ReadFile(filepath.Join("testdata", "astropy-12907.gold.patch"))
	if err != nil {
		t.Fatal(err)
	}
	apply := exec.CommandContext(ctx, "git", "-C", checkout, "apply", "-")
	apply.Stdin = strings.NewReader(string(gold))
	if out, err := apply.CombinedOutput(); err != nil {
		t.Fatalf("applying the gold patch to the checkout: %v: %s", err, out)
	}

	patch, err := PatchFrom(ctx, checkout)
	if err != nil {
		t.Fatalf("patch from the edited checkout: %v", err)
	}
	if !strings.Contains(patch, "separable.py") {
		t.Fatalf("the reconstructed patch does not contain the edited file:\n%s", patch)
	}

	log, err = RunEval(ctx, in, patch)
	if err != nil {
		t.Fatalf("eval with the gold patch: %v", err)
	}
	resolved, why = Score(log, in.FailToPass, in.PassToPass)
	if !resolved {
		t.Fatalf("the gold patch scored as UNRESOLVED: %v\n\n--- tail of log ---\n%s", why, tail(log, 4000))
	}
}

func pinnedSubsetPath(t *testing.T) string {
	t.Helper()
	// ../../../../evals/swebench/... from internal/agent/eval/swebench
	return filepath.Join("..", "..", "..", "..", "evals", "swebench", "verified-subset.json")
}

func tail(s string, n int) string {
	if len(s) <= n {
		return s
	}
	return "..." + s[len(s)-n:]
}

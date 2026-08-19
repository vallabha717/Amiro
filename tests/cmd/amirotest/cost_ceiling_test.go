package main

import (
	"os"
	"path/filepath"
	"testing"

	"amiro/tests/harness/run"
)

// writeCostLines writes raw costs.ndjson lines directly -- the same file
// run.Run.RecordCost produces -- so this test can exercise
// checkCostCeiling without needing a real *run.Run or config.Result.
func writeCostLines(t *testing.T, dir string, lines ...string) {
	t.Helper()
	if err := os.MkdirAll(dir, 0o755); err != nil {
		t.Fatal(err)
	}
	f, err := os.OpenFile(filepath.Join(dir, run.CostFile), os.O_CREATE|os.O_WRONLY|os.O_APPEND, 0o644)
	if err != nil {
		t.Fatal(err)
	}
	defer f.Close()
	for _, l := range lines {
		if _, err := f.WriteString(l + "\n"); err != nil {
			t.Fatal(err)
		}
	}
}

func TestCheckCostCeiling_FiresOnlyWhenSetAndExceeded(t *testing.T) {
	dir := t.TempDir()

	if exceeded, total := checkCostCeiling(dir, 0); exceeded || total != 0 {
		t.Fatalf("ceiling 0 (unset) must never fire, even with no cost file at all: exceeded=%v total=%v", exceeded, total)
	}

	writeCostLines(t, dir, `{"surface":"backend","usd":1.00}`)
	if exceeded, total := checkCostCeiling(dir, 2.00); exceeded {
		t.Fatalf("spend %v under ceiling 2.00 must not fire", total)
	}

	writeCostLines(t, dir, `{"surface":"tui","usd":1.50}`)
	exceeded, total := checkCostCeiling(dir, 2.00)
	if !exceeded {
		t.Fatalf("spend %v over ceiling 2.00 must fire, got exceeded=false", total)
	}
	if total < 2.49 || total > 2.51 {
		t.Fatalf("total = %v, want ~2.50", total)
	}

	// A ceiling that is still unset (0) must not fire no matter how much
	// was spent -- costCeilingUsd's own doc: "ignored in replay and fake
	// mode, where spend is always 0" implies an unset ceiling is "no
	// ceiling", not "zero tolerance".
	if exceeded, _ := checkCostCeiling(dir, 0); exceeded {
		t.Fatalf("ceiling 0 (unset) fired even with real spend on disk -- unset must mean no ceiling, not a zero-tolerance one")
	}
}

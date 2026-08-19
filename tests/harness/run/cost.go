package run

import (
	"bufio"
	"bytes"
	"encoding/json"
	"os"
	"path/filepath"
)

// CostEntry is one test's provider spend, appended to CostFile.
type CostEntry struct {
	Surface string  `json:"surface"`
	USD     float64 `json:"usd"`
}

// CostFile is the append-only record of every test's provider spend,
// mirroring ResultsFile's own reasoning: several `go test` processes (one
// per surface, per cmd/amirotest/run.go's execute) contribute to one run,
// and only a shared file -- not any one process's memory -- can hold all
// of them. run.costCeilingUsd is enforced against the SUM of this file,
// checked by the orchestrator after each invocation.
//
// A cost is only ever non-zero in live/record mode (cassette.CostTracker
// zeroes it for fake/replay), so this file, and the ceiling check built on
// it, are inert in every mode this test system actually runs in today
// without real provider keys -- see docs/testing/progress/phase-07-cross-surface.md's
// notes on run.costCeilingUsd for what closes that gap.
const CostFile = "costs.ndjson"

// RecordCost appends one test's spend and refreshes the summary, mirroring
// RecordResult's own reasoning: an interrupted run should still show
// accumulated spend, not only a run that reached the end. Safe to call
// with usd == 0 -- most entries will be, and the file still records that
// the check ran.
func (r *Run) RecordCost(surface string, usd float64) {
	r.Log.NDJSON(CostFile, CostEntry{Surface: surface, USD: usd})
	_ = r.WriteSummary()
}

// TotalCost sums every recorded entry in the run directory.
func TotalCost(dir string) (float64, error) {
	f, err := os.Open(filepath.Join(dir, CostFile))
	if err != nil {
		if os.IsNotExist(err) {
			return 0, nil
		}
		return 0, err
	}
	defer f.Close()

	var total float64
	sc := bufio.NewScanner(f)
	sc.Buffer(make([]byte, 0, 64<<10), 4<<20)
	for sc.Scan() {
		line := bytes.TrimSpace(sc.Bytes())
		if len(line) == 0 {
			continue
		}
		var e CostEntry
		if err := json.Unmarshal(line, &e); err != nil {
			// One malformed line must not lose the running total, the same
			// tolerance LoadResults gives a killed process's partial write.
			continue
		}
		total += e.USD
	}
	return total, sc.Err()
}

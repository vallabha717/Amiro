package main

import (
	"bufio"
	"encoding/json"
	"flag"
	"fmt"
	"os"
	"path/filepath"
	"strings"

	"amiro/tests/harness/config"
	"amiro/tests/harness/logging"
	"amiro/tests/harness/run"
)

// cmdReport re-renders a past run, or filters its timeline to one test.
//
// The timeline filter is the interesting half. events.ndjson interleaves
// every surface on one clock, so `--timeline --test 'ui/chat/streams
// tokens'` answers "the browser clicked, the backend got the request, the
// provider replayed, frames came back, the DOM never updated" from one
// file -- without opening five.
func cmdReport(args []string) int {
	fs := flag.NewFlagSet("report", flag.ContinueOnError)
	var common commonFlags
	common.register(fs)
	runID := fs.String("run", "", "run id (default: the newest)")
	timeline := fs.Bool("timeline", false, "print the merged event timeline instead of the summary")
	test := fs.String("test", "", "filter the timeline to one test address")
	surface := fs.String("surface", "", "filter the timeline to one surface")
	if err := fs.Parse(args); err != nil {
		return exitConfig
	}

	res, code := loadConfig(common)
	if code != exitOK {
		return code
	}
	logsDir := config.Resolve(res.BaseDir, res.Config.Logging.Dir)

	dir := filepath.Join(logsDir, run.LatestLink)
	if *runID != "" {
		dir = filepath.Join(logsDir, *runID)
	}
	if _, err := os.Stat(dir); err != nil {
		fmt.Fprintf(os.Stderr, "amirotest: no such run: %s\n", dir)
		return exitConfig
	}

	if *timeline {
		return printTimeline(dir, *test, *surface)
	}

	summary, err := run.ReadSummary(dir)
	if err != nil {
		// A run that was interrupted has results but no summary. Rebuilding
		// from results.ndjson is exactly the case the file exists for.
		results, loadErr := run.LoadResults(dir)
		if loadErr != nil || len(results) == 0 {
			fmt.Fprintf(os.Stderr, "amirotest: %s has no summary and no results: %v\n", dir, err)
			return exitConfig
		}
		fmt.Fprintf(os.Stderr, "note: %s has no summary.json (the run was interrupted); rebuilding from %s\n",
			dir, run.ResultsFile)
		summary = &run.Summary{RunID: filepath.Base(dir), Tests: results}
		for _, t := range results {
			switch t.Status {
			case run.StatusPassed:
				summary.Totals.Passed++
			case run.StatusFailed:
				summary.Totals.Failed++
			default:
				summary.Totals.Skipped++
			}
		}
	}
	fmt.Print(run.RenderMarkdown(*summary, dir))
	if summary.Totals.Failed > 0 {
		return exitFailed
	}
	return exitOK
}

func printTimeline(dir, test, surface string) int {
	path := filepath.Join(dir, logging.EventsFile)
	f, err := os.Open(path)
	if err != nil {
		fmt.Fprintf(os.Stderr, "amirotest: %v\n", err)
		return exitConfig
	}
	defer f.Close()

	sc := bufio.NewScanner(f)
	sc.Buffer(make([]byte, 0, 64<<10), 8<<20)
	shown := 0
	for sc.Scan() {
		var e logging.Event
		if err := json.Unmarshal(sc.Bytes(), &e); err != nil {
			continue
		}
		if test != "" && e.Test != test {
			continue
		}
		if surface != "" && e.Surface != surface {
			continue
		}
		fmt.Printf("%s  %-8s %-9s %s", e.TS.Format("15:04:05.000"), e.Surface, e.Kind, e.Msg)
		if len(e.Detail) > 0 {
			raw, _ := json.Marshal(e.Detail)
			fmt.Printf("  %s", raw)
		}
		fmt.Println()
		shown++
	}
	if err := sc.Err(); err != nil {
		fmt.Fprintf(os.Stderr, "reading events: %v\n", err)
	}
	if shown == 0 {
		var filters []string
		if test != "" {
			filters = append(filters, "test="+test)
		}
		if surface != "" {
			filters = append(filters, "surface="+surface)
		}
		fmt.Printf("No events matched %s in %s.\n", strings.Join(filters, " "), path)
	}
	return exitOK
}

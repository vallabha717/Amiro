// Command swebench-pin fetches SWE-bench Verified instances from HuggingFace
// and writes them to a pinned subset file for the eval harness.
//
//	go run ./cmd/swebench-pin -out evals/swebench/verified-subset.json \
//	    -ids astropy__astropy-12907,django__django-11099
//
//	go run ./cmd/swebench-pin -out evals/swebench/verified-subset.json -n 10
//
// # Why the data is pinned rather than fetched at run time
//
// A regression gate has to compare two runs, which means the tasks must be
// the same tasks. Fetching at run time would make the suite depend on a
// third-party service being reachable and on the dataset not being revised
// underneath it -- and a benchmark whose contents can change silently reports
// a number that cannot be compared with last week's.
//
// So this is run deliberately, its output is committed, and a change to the
// benchmark shows up as a diff someone approved.
package main

import (
	"encoding/json"
	"flag"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"time"

	"amiro/backend/internal/agent/eval/swebench"
)

// The dataset viewer API. Chosen over downloading the parquet files because
// it needs no parquet reader and no auth for a public dataset, and the subset
// this pins is small by design.
const (
	datasetsServer = "https://datasets-server.huggingface.co/rows"
	dataset        = "SWE-bench/SWE-bench_Verified"
	pageSize       = 100 // the API's maximum
)

func main() {
	var (
		out    = flag.String("out", "evals/swebench/verified-subset.json", "where to write the pinned subset")
		ids    = flag.String("ids", "", "comma-separated instance ids to pin")
		n      = flag.Int("n", 0, "pin the first N runnable instances instead of naming them")
		offset = flag.Int("offset", 0, "start scanning the dataset at this row")
	)
	flag.Parse()

	if *ids == "" && *n == 0 {
		fail(fmt.Errorf("pass -ids or -n"))
	}

	wanted := map[string]bool{}
	for _, id := range strings.Split(*ids, ",") {
		if id = strings.TrimSpace(id); id != "" {
			wanted[id] = true
		}
	}

	// Captured before the scan: `wanted` empties as ids are found, so testing
	// its length inside the loop would flip the tool into "pick anything"
	// mode the moment the last named instance was matched.
	byName := len(wanted) > 0

	var picked []swebench.Instance
	seen := 0
	for row := *offset; row < 500; row += pageSize {
		batch, err := fetchRows(row, pageSize)
		if err != nil {
			fail(err)
		}
		if len(batch) == 0 {
			break
		}
		for _, in := range batch {
			seen++
			if byName {
				if !wanted[in.ID] {
					continue
				}
			} else {
				// Unnamed picking skips what this adapter cannot score, so
				// `-n 5` yields five instances that will actually run rather
				// than five that fail at load.
				if err := in.Validate(); err != nil {
					continue
				}
				if supported, known := swebench.SupportedLogParsers[in.Parser()]; known && !supported {
					continue
				}
			}
			picked = append(picked, in)
			delete(wanted, in.ID)
			if *n > 0 && len(picked) >= *n {
				break
			}
		}
		if (*n > 0 && len(picked) >= *n) || (byName && len(wanted) == 0) {
			break
		}
	}

	if len(wanted) > 0 {
		names := make([]string, 0, len(wanted))
		for id := range wanted {
			names = append(names, id)
		}
		fail(fmt.Errorf("not found in %s after scanning %d rows: %s", dataset, seen, strings.Join(names, ", ")))
	}
	if len(picked) == 0 {
		fail(fmt.Errorf("nothing pinned"))
	}

	// Validated before writing, not after: a pinned file that cannot be
	// loaded is worse than no file, because it is discovered by whoever next
	// tries to run the gate rather than by whoever created it.
	for _, in := range picked {
		if err := in.Validate(); err != nil {
			fail(err)
		}
	}

	raw, err := json.MarshalIndent(picked, "", "  ")
	if err != nil {
		fail(err)
	}
	if err := os.MkdirAll(filepath.Dir(*out), 0o755); err != nil {
		fail(err)
	}
	if err := os.WriteFile(*out, append(raw, '\n'), 0o644); err != nil {
		fail(err)
	}

	fmt.Fprintf(os.Stderr, "pinned %d instances to %s\n", len(picked), *out)
	for _, in := range picked {
		fmt.Fprintf(os.Stderr, "  %-34s %-22s %s\n", in.ID, in.Difficulty, in.Image)
	}
}

func fetchRows(offset, length int) ([]swebench.Instance, error) {
	q := url.Values{}
	q.Set("dataset", dataset)
	q.Set("config", "default")
	q.Set("split", "test")
	q.Set("offset", fmt.Sprint(offset))
	q.Set("length", fmt.Sprint(length))

	client := &http.Client{Timeout: 2 * time.Minute}
	resp, err := client.Get(datasetsServer + "?" + q.Encode())
	if err != nil {
		return nil, fmt.Errorf("swebench-pin: %w", err)
	}
	defer resp.Body.Close()
	body, err := io.ReadAll(resp.Body)
	if err != nil {
		return nil, fmt.Errorf("swebench-pin: %w", err)
	}
	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("swebench-pin: %s: %s", resp.Status, clip(string(body)))
	}

	var payload struct {
		Rows []struct {
			Row swebench.Instance `json:"row"`
		} `json:"rows"`
	}
	if err := json.Unmarshal(body, &payload); err != nil {
		return nil, fmt.Errorf("swebench-pin: decode: %w", err)
	}
	instances := make([]swebench.Instance, 0, len(payload.Rows))
	for _, r := range payload.Rows {
		instances = append(instances, r.Row)
	}
	return instances, nil
}

func clip(s string) string {
	if len(s) <= 400 {
		return s
	}
	return s[:400] + "..."
}

func fail(err error) {
	fmt.Fprintf(os.Stderr, "swebench-pin: %v\n", err)
	os.Exit(2)
}

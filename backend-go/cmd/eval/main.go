// Command eval runs the agent against a task suite and reports the metrics
// Part 4 of docs/agentic-loop-implementation-plan.md tracks.
//
//	go run ./cmd/eval -suite evals/smoke.json -provider openai -model gpt-5
//	go run ./cmd/eval -swebench evals/swebench/verified-subset.json
//
// -suite and -swebench are the two ways to name a task set. They produce the
// same kind of run and the same report; the difference is only where the
// tasks come from, which is the point of the adapter
// (internal/agent/eval/swebench) rather than a second harness.
//
// It does not start the server or go through the HTTP path -- no auth, no
// thread, nothing persisted. It does open the app database, because that is
// where provider credentials live: the harness has to reach a model, and
// inventing a second place to configure keys would mean a benchmark run
// against a provider config the app does not use.
//
// Exits non-zero when any task is unresolved, so it can be a CI gate. The
// JSON report (-json) is the thing to keep: comparing two runs is the whole
// point, and a terminal summary is not diffable.
package main

import (
	"context"
	"encoding/json"
	"flag"
	"fmt"
	"os"
	"os/signal"
	"path/filepath"
	"syscall"

	"amiro/backend/internal/agent/eval"
	"amiro/backend/internal/agent/eval/swebench"
	bifrostai "amiro/backend/internal/ai/bifrost"
	"amiro/backend/internal/api/chat"
	"amiro/backend/internal/config"
	"amiro/backend/internal/db"
	"amiro/backend/internal/db/repository"
)

func main() {
	var (
		suitePath = flag.String("suite", "", "path to a task suite JSON file (default evals/smoke.json when -swebench is not given)")
		swePath   = flag.String("swebench", "", "path to a pinned SWE-bench subset (see cmd/swebench-pin)")
		sweCache  = flag.String("swebench-cache", "", "where materialized SWE-bench checkouts are cached")
		provider  = flag.String("provider", "", "provider id (defaults to the app's default)")
		model     = flag.String("model", "", "model id (defaults to the app's default)")
		jsonOut   = flag.String("json", "", "write the full report as JSON to this path")
		workDir   = flag.String("workdir", "", "where to create task workspaces (default: OS temp)")
		keep      = flag.Bool("keep", false, "keep task workspaces after the run, for inspection")
		only      = flag.String("only", "", "run just this task id")
	)
	flag.Parse()

	if *suitePath != "" && *swePath != "" {
		fail(fmt.Errorf("pass either -suite or -swebench, not both"))
	}
	if *suitePath == "" && *swePath == "" {
		*suitePath = "evals/smoke.json"
	}

	// Built here so the SWE-bench branch can register its scorer on the
	// runner below. Everything after this point is identical for both suite
	// kinds -- one runner, one report, one exit code.
	var (
		suite   *eval.Suite
		adapter *swebench.Adapter
		err     error
	)
	if *swePath != "" {
		instances, loadErr := swebench.LoadInstances(*swePath)
		if loadErr != nil {
			fail(loadErr)
		}
		adapter, err = swebench.NewAdapter(instances, swebench.Options{CacheDir: *sweCache})
		if err != nil {
			fail(err)
		}
		suite = adapter.Suite("swe-bench-verified (" + filepath.Base(*swePath) + ")")
	} else {
		suite, err = eval.LoadSuite(*suitePath)
		if err != nil {
			fail(err)
		}
	}

	if *only != "" {
		var filtered []eval.Task
		for _, t := range suite.Tasks {
			if t.ID == *only {
				filtered = append(filtered, t)
			}
		}
		if len(filtered) == 0 {
			fail(fmt.Errorf("no task with id %q in the suite", *only))
		}
		suite.Tasks = filtered
	}

	cfg, err := config.Load()
	if err != nil {
		fail(err)
	}
	gdb, err := db.Open(cfg.DatabaseDriver, cfg.DatabaseDSN)
	if err != nil {
		fail(fmt.Errorf("database: %w", err))
	}
	client, err := bifrostai.NewClient(context.Background(), repository.NewProviderRepository(gdb))
	if err != nil {
		fail(fmt.Errorf("provider setup: %w", err))
	}
	defer client.Shutdown()

	// Ctrl-C stops after the current task rather than killing the process,
	// so a run that is going badly still prints what it learned. A harness
	// that discards its results on interrupt trains you not to interrupt it.
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()

	runner := &eval.Runner{
		Agent:   chat.NewEvalAgent(client, bifrostai.Resolve(*provider, *model)),
		WorkDir: *workDir,
		Keep:    *keep,
		Log:     os.Stderr,
	}

	if adapter != nil {
		adapter.Register(runner)
		// Materialize every checkout before the first model call. Pulling a
		// multi-gigabyte image can fail, and finding that out on instance 7
		// of 50 means an hour of model spend already gone.
		fmt.Fprintf(os.Stderr, "materializing %d SWE-bench checkouts (first run pulls images)...\n", len(suite.Tasks))
		if err := adapter.Prepare(ctx); err != nil {
			fail(err)
		}
	}

	report, runErr := runner.Run(ctx, suite)
	fmt.Println(report)

	if *jsonOut != "" {
		raw, err := json.MarshalIndent(report, "", "  ")
		if err != nil {
			fail(err)
		}
		if err := os.WriteFile(*jsonOut, raw, 0o644); err != nil {
			fail(err)
		}
		fmt.Fprintf(os.Stderr, "report written to %s\n", *jsonOut)
	}

	if runErr != nil {
		fmt.Fprintf(os.Stderr, "run interrupted: %v\n", runErr)
		os.Exit(2)
	}
	if s := report.Summary(); s.Resolved < s.Tasks {
		os.Exit(1)
	}
}

func fail(err error) {
	fmt.Fprintf(os.Stderr, "eval: %v\n", err)
	os.Exit(2)
}

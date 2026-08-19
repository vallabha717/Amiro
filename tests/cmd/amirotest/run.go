package main

import (
	"context"
	"flag"
	"fmt"
	"os"
	"os/exec"
	"strings"
	"time"

	"amiro/tests/harness/config"
	"amiro/tests/harness/logging"
	"amiro/tests/harness/run"
	"amiro/tests/harness/selector"
)

func cmdRun(args []string) int {
	fs := flag.NewFlagSet("run", flag.ContinueOnError)
	var common commonFlags
	var sel selectionFlags
	common.register(fs)
	sel.register(fs)

	parallel := fs.Int("parallel", 0, "workers per surface (0 = config)")
	updateGolden := fs.Bool("update-golden", false, "rewrite golden files instead of comparing them")
	live := fs.Bool("live", false, "providers.mode=live for this run")
	fake := fs.Bool("fake", false, "providers.mode=fake for this run")
	providersMode := fs.String("providers-mode", "", "fake | replay | record | live -- overrides providers.mode")
	keepArtifacts := fs.String("keep-artifacts", "", "always | on-failure | never")
	failFast := fs.Bool("fail-fast", false, "stop at the first failure")
	verbose := fs.Bool("verbose", false, "stream the underlying runner's output")
	dryRun := fs.Bool("dry-run", false, "print what would run, and run nothing")
	if err := fs.Parse(args); err != nil {
		return exitConfig
	}

	overrides := []config.Override{func(c *config.Config) {
		sel.apply(c)
		if *parallel > 0 {
			c.Run.Parallel = *parallel
		}
		if *live {
			c.Providers.Mode = "live"
		}
		if *fake {
			c.Providers.Mode = "fake"
		}
		if *providersMode != "" {
			c.Providers.Mode = *providersMode
		}
		if *keepArtifacts != "" {
			c.Run.KeepArtifacts = *keepArtifacts
		}
		if *failFast {
			c.Run.FailFast = true
		}
		if *updateGolden {
			c.TUI.GoldenUpdate = true
		}
	}}

	res, code := loadConfig(common, overrides...)
	if code != exitOK {
		return code
	}
	if *live && *fake {
		fmt.Fprintln(os.Stderr, "amirotest: --live and --fake contradict each other")
		return exitConfig
	}

	cat, err := selector.Discover(res.BaseDir)
	if err != nil {
		fmt.Fprintf(os.Stderr, "amirotest: discovering suites: %v\n", err)
		return exitInfra
	}
	selection := sel.selection(&res.Config)
	selection.UpdateGolden = *updateGolden

	invocations, emptySurfaces, err := selector.Resolve(selection, cat)
	if err != nil {
		fmt.Fprintf(os.Stderr, "amirotest: %v\n", err)
		return exitConfig
	}
	for _, surface := range emptySurfaces {
		// Recorded rather than silent: a surface with no suite yet must show
		// up in summary.md saying so, not be absent and read as green.
		where := "suites/" + surface + "/"
		if surface == "ui" {
			where = "ui/specs/"
		}
		run.SkipSurface(surface, "no suite exists yet under "+where)
	}

	if *dryRun {
		fmt.Printf("Selection: %s\n", selection.String())
		for _, inv := range invocations {
			fmt.Printf("  %-8s %s %s\n", inv.Surface, inv.Runner, strings.Join(inv.Args, " "))
		}
		return exitOK
	}

	r, err := run.Mint(res, selection)
	if err != nil {
		fmt.Fprintf(os.Stderr, "amirotest: %v\n", err)
		return exitInfra
	}
	defer r.Log.Close()
	defer cmdBackendSweep([]string{"--run-dir", r.Dir})

	fmt.Printf("run %s\n  %s\n  providers: %s · parallel: %d\n\n",
		r.ID, r.Dir, res.Config.Providers.Mode, res.Config.Run.Parallel)

	ctx, cancel := context.WithTimeout(context.Background(), res.Config.Run.Timeout.Duration())
	defer cancel()

	exit := execute(ctx, r, res, invocations, *verbose)

	if err := r.WriteSummary(); err != nil {
		fmt.Fprintf(os.Stderr, "amirotest: writing summary: %v\n", err)
	}
	summary := r.Summarise()
	fmt.Print("\n" + run.RenderMarkdown(summary, r.Dir))
	if summary.Totals.Failed > 0 {
		return exitFailed
	}
	return exit
}

// execute runs each invocation.
//
// Surfaces run one after another here rather than concurrently, and that is
// a deliberate Phase 1 limitation rather than the end state: `go test`
// already parallelises WITHIN a surface (run.parallel becomes -parallel),
// and cross-surface concurrency mainly matters once the UI and desktop
// surfaces exist to overlap with. Doing it now would mean interleaving two
// runners' output with no way to read it. Recorded as a Phase 5 follow-up.
func execute(ctx context.Context, r *run.Run, res *config.Result, invocations []selector.Invocation, verbose bool) int {
	worst := exitOK
	for _, inv := range invocations {
		fmt.Printf("── %s ──\n", inv.Surface)
		code := runInvocation(ctx, r, res, inv, verbose, 1)
		if inv.Runner == "go" {
			code = retryFailures(ctx, r, res, inv, verbose, code)
		}
		if code > worst {
			worst = code
		}

		// run.costCeilingUsd: only ever non-zero in live/record mode
		// (cassette.CostTracker zeroes spend in fake/replay), so this is a
		// no-op on every run this test system can actually exercise without
		// real provider keys -- see cmd/amirotest/run.go's checkCostCeiling
		// doc and docs/testing/progress/phase-07-cross-surface.md.
		if exceeded, total := checkCostCeiling(r.Dir, res.Config.Run.CostCeilingUSD); exceeded {
			fmt.Printf("\nstopping: spend $%.2f has passed run.costCeilingUsd ($%.2f) after %s\n",
				total, res.Config.Run.CostCeilingUSD, inv.Surface)
			if worst < exitFailed {
				worst = exitFailed
			}
			break
		}

		if code != exitOK && res.Config.Run.FailFast {
			fmt.Printf("\nstopping: run.failFast is set and %s failed\n", inv.Surface)
			break
		}
	}
	return worst
}

// checkCostCeiling reports whether accumulated spend (run.CostFile, summed
// across every test in every surface run so far this run) has passed
// run.costCeilingUsd. A ceiling of 0 means "unset" -- not "spend nothing"
// -- matching costCeilingUsd's own doc ("ignored in replay and fake mode,
// where spend is always 0"): a config that never sets a ceiling must not
// suddenly start failing runs the moment any real spend at all occurs.
func checkCostCeiling(runDir string, ceilingUSD float64) (exceeded bool, total float64) {
	if ceilingUSD <= 0 {
		return false, 0
	}
	total, err := run.TotalCost(runDir)
	if err != nil {
		return false, 0
	}
	return total > ceilingUSD, total
}

// retryFailures re-invokes ONLY the tests that failed on a previous
// attempt, up to res.Config.Run.Retries times, per run.retries.
//
// validate.go already warns that retries above 3 "will hide a race rather
// than reveal it; CI should use 0" -- this function is what makes a retry
// that DOES happen impossible to mistake for a clean pass: every attempt
// is recorded (harness.Harness reads AMIRO_TEST_ATTEMPT and stamps it on
// the TestResult), and summary.go's Summarise/RenderMarkdown surface a
// Retried section unconditionally whenever more than one attempt exists
// for an address, even though the final verdict counts once. A test that
// needs a retry is investigated, not quietly re-run into invisibility.
func retryFailures(ctx context.Context, r *run.Run, res *config.Result, inv selector.Invocation, verbose bool, code int) int {
	retries := res.Config.Run.Retries
	if retries <= 0 || code != exitFailed {
		return code
	}

	baseArgs := stripRunFlag(inv.Args)
	lastCode := code
	for attempt := 2; attempt <= 1+retries; attempt++ {
		names := stillFailing(r.Dir, inv.Surface)
		if len(names) == 0 {
			break
		}
		fmt.Printf("\nretrying %d test(s) in %s (attempt %d/%d): %s\n",
			len(names), inv.Surface, attempt, 1+retries, strings.Join(names, ", "))

		retryInv := selector.Invocation{
			Surface: inv.Surface,
			Runner:  inv.Runner,
			Args:    append(append([]string{}, baseArgs...), "-run", "^("+strings.Join(names, "|")+")$"),
			Serial:  inv.Serial,
		}
		lastCode = runInvocation(ctx, r, res, retryInv, verbose, attempt)
	}

	if len(stillFailing(r.Dir, inv.Surface)) == 0 {
		return exitOK
	}
	return lastCode
}

// stillFailing returns the Name (not full Address, since -run matches Go
// test function names) of every test in surface whose LAST recorded
// attempt is a failure -- a test that already passed on a previous retry
// round is not retried again.
func stillFailing(runDir, surface string) []string {
	tests, err := run.LoadResults(runDir)
	if err != nil {
		return nil
	}
	type key struct {
		address string
	}
	last := map[key]run.TestResult{}
	var order []key
	for _, t := range tests {
		if t.Surface != surface {
			continue
		}
		k := key{t.Address}
		if _, seen := last[k]; !seen {
			order = append(order, k)
		}
		if existing, ok := last[k]; !ok || t.Attempt >= existing.Attempt {
			last[k] = t
		}
	}
	var names []string
	seen := map[string]bool{}
	for _, k := range order {
		t := last[k]
		if t.Status != run.StatusFailed || seen[t.Name] {
			continue
		}
		seen[t.Name] = true
		names = append(names, t.Name)
	}
	return names
}

// stripRunFlag removes an existing "-run VALUE" pair from args, so a
// retry's own targeted -run is never combined with (and silently
// overridden or duplicated by) whatever --grep selection produced the
// first attempt's args.
func stripRunFlag(args []string) []string {
	out := make([]string, 0, len(args))
	for i := 0; i < len(args); i++ {
		if args[i] == "-run" && i+1 < len(args) {
			i++
			continue
		}
		out = append(out, args[i])
	}
	return out
}

func runInvocation(ctx context.Context, r *run.Run, res *config.Result, inv selector.Invocation, verbose bool, attempt int) int {
	var cmd *exec.Cmd
	switch inv.Runner {
	case "go":
		args := append([]string{}, inv.Args...)
		args = append(args,
			fmt.Sprintf("-parallel=%d", res.Config.Run.Parallel),
			fmt.Sprintf("-timeout=%s", res.Config.Run.Timeout.String()),
		)
		if verbose {
			args = append(args, "-v")
		}
		// -count=1 defeats Go's test result cache. A cached PASS is not a
		// run: it produces no artifacts, no timeline and no evidence, which
		// is the opposite of what this suite exists for.
		args = append(args, "-count=1")
		cmd = exec.CommandContext(ctx, "go", args...)
	case "playwright":
		cmd = exec.CommandContext(ctx, "pnpm", append([]string{"exec"}, inv.Args...)...)
	default:
		fmt.Fprintf(os.Stderr, "amirotest: unknown runner %q\n", inv.Runner)
		return exitInfra
	}

	cmd.Dir = res.BaseDir
	// Every child joins THIS run rather than minting its own, which is what
	// makes one directory hold every surface's artifacts.
	cmd.Env = append(os.Environ(), r.Env()...)
	cmd.Env = append(cmd.Env, run.EnvSurface+"="+inv.Surface)
	if attempt > 1 {
		cmd.Env = append(cmd.Env, fmt.Sprintf("%s=%d", run.EnvAttempt, attempt))
	}
	cmd.Stdout = os.Stdout
	cmd.Stderr = os.Stderr

	started := time.Now()
	r.Log.Emit(logging.Event{Surface: inv.Surface, Kind: logging.KindRun, Msg: "runner started",
		Detail: map[string]any{"runner": inv.Runner, "args": inv.Args}})

	err := cmd.Run()
	elapsed := time.Since(started)
	r.Log.Emit(logging.Event{Surface: inv.Surface, Kind: logging.KindRun, Msg: "runner finished",
		Detail: map[string]any{"ms": elapsed.Milliseconds(), "error": errString(err)}})

	if err == nil {
		return exitOK
	}
	var exitErr *exec.ExitError
	if asExitError(err, &exitErr) {
		// `go test` exits 1 for a failing test and 2 for a build failure or
		// a bad flag. Those are different problems and the caller reports
		// them differently -- see the exit code table in main.go.
		if exitErr.ExitCode() == 1 {
			return exitFailed
		}
		return exitInfra
	}
	if ctx.Err() != nil {
		fmt.Fprintf(os.Stderr, "amirotest: %s timed out after %s\n", inv.Surface, res.Config.Run.Timeout)
		return exitFailed
	}
	// A missing runner is infrastructure, not a test failure. `pnpm` not
	// being installed should never read as "the UI is broken".
	fmt.Fprintf(os.Stderr, "amirotest: could not run %s: %v\n", inv.Runner, err)
	if inv.Surface == "ui" {
		run.SkipSurface("ui", "playwright could not be launched: "+err.Error())
	}
	return exitInfra
}

func asExitError(err error, target **exec.ExitError) bool {
	for err != nil {
		if e, ok := err.(*exec.ExitError); ok {
			*target = e
			return true
		}
		u, ok := err.(interface{ Unwrap() error })
		if !ok {
			return false
		}
		err = u.Unwrap()
	}
	return false
}

func errString(err error) string {
	if err == nil {
		return ""
	}
	return err.Error()
}

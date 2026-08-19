// Command amirotest is the one entrypoint for the Amiro test system.
//
//	amirotest run                                  everything config.yaml selects
//	amirotest run --surface ui                     one surface
//	amirotest run --surface ui --feature chat      one feature of one surface
//	amirotest run --feature chat                   that feature on EVERY surface
//	amirotest list                                 every discovered address
//	amirotest doctor                               is the toolchain complete?
//
// It is deliberately NOT the only way to run a test. `go test
// ./suites/backend/smoke` and `pnpm playwright test ui/specs/chat` work with
// no ceremony, because the harness self-bootstraps -- see
// docs/testing/03-selection.md. This binary orchestrates; it does not gate.
package main

import (
	"fmt"
	"os"
)

// Exit codes, from docs/testing/03-selection.md. 3 is distinct from 1 on
// purpose: "the suite could not run" and "the code is broken" demand
// different responses, and CI should surface them differently.
const (
	exitOK     = 0
	exitFailed = 1
	exitConfig = 2
	exitInfra  = 3
)

func main() {
	args := os.Args[1:]
	if len(args) == 0 {
		usage()
		os.Exit(exitConfig)
	}

	cmd, rest := args[0], args[1:]
	var code int
	switch cmd {
	case "run":
		code = cmdRun(rest)
	case "list":
		code = cmdList(rest)
	case "doctor":
		code = cmdDoctor(rest)
	case "record":
		code = cmdRecord(rest)
	case "report":
		code = cmdReport(rest)
	case "env":
		code = cmdEnv(rest)
	case "config":
		code = cmdConfig(rest)
	case "backend":
		code = cmdBackend(rest)
	case "internal-fakeprovider":
		code = cmdInternalFakeProvider(rest)
	case "clean":
		code = cmdClean(rest)
	case "help", "-h", "--help":
		usage()
		code = exitOK
	default:
		fmt.Fprintf(os.Stderr, "amirotest: unknown command %q\n\n", cmd)
		usage()
		code = exitConfig
	}
	os.Exit(code)
}

func usage() {
	fmt.Print(`amirotest -- the Amiro test system

Usage:
  amirotest run [flags]        run the selected tests
  amirotest list [flags]       print every discovered surface/feature/test address
  amirotest doctor             report the toolchain state and what it means for the run
  amirotest record [flags]     run in ` + "`record`" + ` provider mode, writing cassettes
  amirotest report [flags]     re-render a past run's summary, or filter its timeline
  amirotest env [flags]        print the environment a standalone runner needs
  amirotest backend [start|stop|sweep]  start/stop an isolated backend instance
  amirotest config example     regenerate config.example.yaml from the defaults
  amirotest clean              prune logs/ to logging.keepRuns

Selection flags (run, list, record):
  --surface S[,S]    backend | tui | ui | desktop | cross | meta
  --feature F[,F]    a directory name under suites/<surface>/ or ui/specs/
  --grep PATTERN     narrow to matching test names
  --tag T[,T]        run only tests carrying these tags (implies un-excluding them)
  --browser B[,B]    chromium | firefox | webkit (ui surface)

Run flags:
  --parallel N       workers per surface
  --update-golden    rewrite golden files instead of comparing them
  --live             providers.mode=live for this run
  --fake             providers.mode=fake for this run
  --keep-artifacts M always | on-failure | never
  --fail-fast        stop at the first failure
  --verbose          stream the underlying runner's output
  --dry-run          print what would run, and run nothing

Common flags:
  --config PATH      use this config file instead of tests/config.yaml
  --dir PATH         the tests/ directory (default: discovered)

Every key in config.yaml is optional, and every one of them can also be set
as AMIRO_TEST_<PATH> -- run ` + "`amirotest env --list`" + ` for the full map.
Flags beat the environment, which beats config.yaml, which beats defaults.

Exit codes: 0 all passed · 1 a test failed · 2 configuration error, nothing
ran · 3 infrastructure failure (a binary would not build, a port would not
bind, a browser was missing).
`)
}

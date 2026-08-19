package main

import (
	"flag"
	"fmt"
	"os"

	"gopkg.in/yaml.v3"

	"amiro/tests/harness/config"
	"amiro/tests/harness/run"
)

func cmdClean(args []string) int {
	fs := flag.NewFlagSet("clean", flag.ContinueOnError)
	var common commonFlags
	common.register(fs)
	all := fs.Bool("all", false, "delete every run directory, not just the ones beyond logging.keepRuns")
	if err := fs.Parse(args); err != nil {
		return exitConfig
	}
	res, code := loadConfig(common)
	if code != exitOK {
		return code
	}
	logsDir := config.Resolve(res.BaseDir, res.Config.Logging.Dir)

	keep := res.Config.Logging.KeepRuns
	if *all {
		keep = 0
		// Prune(dir, 0) means "keep everything", so --all cannot go through
		// it. Removing the tree and recreating it is the honest expression
		// of "delete every run".
		if err := os.RemoveAll(logsDir); err != nil {
			fmt.Fprintf(os.Stderr, "amirotest: %v\n", err)
			return exitInfra
		}
		if err := os.MkdirAll(logsDir, 0o755); err != nil {
			fmt.Fprintf(os.Stderr, "amirotest: %v\n", err)
			return exitInfra
		}
		fmt.Printf("removed every run under %s\n", logsDir)
		return exitOK
	}
	if err := run.Prune(logsDir, keep); err != nil {
		fmt.Fprintf(os.Stderr, "amirotest: %v\n", err)
		return exitInfra
	}
	fmt.Printf("pruned %s to the newest %d runs\n", logsDir, keep)
	return exitOK
}

func yamlMarshal(v any) ([]byte, error) { return yaml.Marshal(v) }

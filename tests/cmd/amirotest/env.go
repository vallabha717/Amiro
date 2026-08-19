package main

import (
	"encoding/json"
	"flag"
	"fmt"
	"os"
	"path/filepath"

	"amiro/tests/harness/config"
	"amiro/tests/harness/run"
)

// cmdEnv prints what a standalone runner needs to join a run.
//
// This is the seam between Go and Playwright (docs/testing/01-architecture.md).
// Playwright's config calls `amirotest env --surface ui` when
// AMIRO_TEST_RUN_DIR is not already set, and gets back a run directory that
// exists, with run.json already in it. That is what makes `pnpm playwright
// test` work standalone without reimplementing configuration resolution in
// TypeScript.
func cmdEnv(args []string) int {
	fs := flag.NewFlagSet("env", flag.ContinueOnError)
	var common commonFlags
	var sel selectionFlags
	common.register(fs)
	sel.register(fs)
	list := fs.Bool("list", false, "print every AMIRO_TEST_* variable and the key it sets")
	asJSON := fs.Bool("json", false, "print as JSON instead of shell exports")
	noMint := fs.Bool("no-mint", false, "do not create a run directory; only report the existing one")
	if err := fs.Parse(args); err != nil {
		return exitConfig
	}

	if *list {
		return listEnvBindings(*asJSON)
	}

	res, code := loadConfig(common, func(c *config.Config) { sel.apply(c) })
	if code != exitOK {
		return code
	}

	var r *run.Run
	if dir := os.Getenv(run.EnvRunDir); dir != "" || *noMint {
		if dir == "" {
			fmt.Fprintln(os.Stderr, "amirotest: --no-mint was given but AMIRO_TEST_RUN_DIR is not set")
			return exitConfig
		}
		var err error
		r, err = run.Open(res, sel.selection(&res.Config))
		if err != nil {
			fmt.Fprintf(os.Stderr, "amirotest: %v\n", err)
			return exitInfra
		}
	} else {
		var err error
		r, err = run.Mint(res, sel.selection(&res.Config))
		if err != nil {
			fmt.Fprintf(os.Stderr, "amirotest: %v\n", err)
			return exitInfra
		}
	}
	defer r.Log.Close()

	surface := "ui"
	if len(sel.surfaces) > 0 {
		surface = sel.surfaces[0]
	}
	vars := map[string]string{
		run.EnvRunDir:    r.Dir,
		run.EnvRunID:     r.ID,
		run.EnvStartedAt: r.StartedAt.Format("2006-01-02T15:04:05.000000000Z07:00"),
		run.EnvSurface:   surface,
	}

	if *asJSON {
		enc := json.NewEncoder(os.Stdout)
		enc.SetIndent("", "  ")
		return encodeOrFail(enc, map[string]any{
			"env":      vars,
			"runDir":   r.Dir,
			"runId":    r.ID,
			"manifest": filepath.Join(r.Dir, run.ManifestName),
			"config":   res.Config,
		})
	}
	for _, k := range []string{run.EnvRunDir, run.EnvRunID, run.EnvStartedAt, run.EnvSurface} {
		fmt.Printf("export %s=%q\n", k, vars[k])
	}
	return exitOK
}

func listEnvBindings(asJSON bool) int {
	bindings := config.EnvBindings()
	if asJSON {
		enc := json.NewEncoder(os.Stdout)
		enc.SetIndent("", "  ")
		return encodeOrFail(enc, bindings)
	}
	fmt.Printf("%-40s %-34s %s\n", "VARIABLE", "CONFIG KEY", "TYPE")
	for _, b := range bindings {
		fmt.Printf("%-40s %-34s %s\n", b.Name, b.Path, b.Kind)
		if b.Alias != "" {
			fmt.Printf("%-40s %-34s %s\n", "  "+b.Alias, "  (same key, readable spelling)", "")
		}
	}
	fmt.Printf("\nList values are comma-separated: %sRUN_SURFACES=ui,backend\n", config.EnvPrefix)
	fmt.Printf("An empty list value means an EMPTY list, not \"use the default\":\n")
	fmt.Printf("  %sRUN_TAGS_EXCLUDE=  runs the slow and live tests too.\n", config.EnvPrefix)
	return exitOK
}

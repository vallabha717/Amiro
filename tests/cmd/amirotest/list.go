package main

import (
	"encoding/json"
	"flag"
	"fmt"
	"os"
	"slices"

	"amiro/tests/harness/selector"
)

func cmdList(args []string) int {
	fs := flag.NewFlagSet("list", flag.ContinueOnError)
	var common commonFlags
	var sel selectionFlags
	common.register(fs)
	sel.register(fs)
	asJSON := fs.Bool("json", false, "print the catalogue as JSON")
	if err := fs.Parse(args); err != nil {
		return exitConfig
	}

	res, code := loadConfig(common)
	if code != exitOK {
		return code
	}
	cat, err := selector.Discover(res.BaseDir)
	if err != nil {
		fmt.Fprintf(os.Stderr, "amirotest: %v\n", err)
		return exitInfra
	}

	if *asJSON {
		enc := json.NewEncoder(os.Stdout)
		enc.SetIndent("", "  ")
		return encodeOrFail(enc, cat)
	}

	if len(cat.Features) == 0 {
		fmt.Println("No suites found.")
		fmt.Printf("Looked under %s/suites/<surface>/<feature>/ and %s/ui/specs/<feature>/.\n", res.BaseDir, res.BaseDir)
		fmt.Println("A feature is a directory; creating one is all it takes to add an address.")
		return exitOK
	}

	total := 0
	var lastSurface string
	for _, f := range cat.Features {
		if len(sel.surfaces) > 0 && !slices.Contains(sel.surfaces, f.Surface) {
			continue
		}
		if len(sel.features) > 0 && !slices.Contains(sel.features, f.Name) {
			continue
		}
		if f.Surface != lastSurface {
			fmt.Printf("\n%s\n", f.Surface)
			lastSurface = f.Surface
		}
		fmt.Printf("  %s/%s  (%d tests)\n", f.Surface, f.Name, len(f.Tests))
		for _, test := range f.Tests {
			fmt.Printf("      %s\n", f.Address(test))
			total++
		}
	}
	fmt.Printf("\n%d tests across %d features.\n", total, len(cat.Features))
	return exitOK
}

func encodeOrFail(enc *json.Encoder, v any) int {
	if err := enc.Encode(v); err != nil {
		fmt.Fprintf(os.Stderr, "amirotest: %v\n", err)
		return exitInfra
	}
	return exitOK
}

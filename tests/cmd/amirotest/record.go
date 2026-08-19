package main

import (
	"fmt"
	"os"
)

// cmdRecord is `run` in record mode: call the real provider APIs and write
// cassettes for later replay.
//
// A separate command rather than a flag on `run` because recording SPENDS
// MONEY and overwrites committed fixtures. Both of those deserve a verb the
// user typed on purpose, not a flag they could reach by editing the
// previous shell line.
func cmdRecord(args []string) int {
	for _, a := range args {
		if a == "--live" || a == "--fake" {
			fmt.Fprintf(os.Stderr, "amirotest: %s contradicts `record` -- record mode calls the real API and writes cassettes\n", a)
			return exitConfig
		}
	}
	fmt.Fprintln(os.Stderr, "recording: real provider APIs will be called and cassettes overwritten")
	return cmdRun(append(args, "--providers-mode=record"))
}

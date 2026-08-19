// Package desktop resolves whether the desktop (Tauri) surface can run on
// this machine, and gives the suites under tests/suites/desktop/ a shared
// way to launch and observe it when it can.
//
// Most of what this package offers cannot be exercised on a machine without
// cargo -- which is the defining fact of Phase 6 (docs/testing/phases/phase-06-desktop.md).
// It still has to exist and be structurally correct, because "correct when
// the toolchain shows up" is the whole point of desktop.enabled: auto, and
// because it is what makes the failure mode of desktop.enabled: true a
// clean message instead of a panic.
package desktop

import (
	"os/exec"
	"strings"
)

// Toolchain is what was found on PATH.
type Toolchain struct {
	CargoFound      bool
	CargoPath       string
	CargoVersion    string
	TauriCLIFound   bool
	TauriCLIVersion string
}

// DetectToolchain probes for cargo and the Tauri CLI (`cargo tauri`).
//
// The Tauri CLI is checked separately from cargo, and deliberately: cargo
// alone builds nothing Tauri-shaped, and a doctor report or a skip reason
// that only checked the first would tell someone "cargo not found" when
// what is actually missing is `cargo install tauri-cli`.
func DetectToolchain() Toolchain {
	var tc Toolchain
	if path, err := exec.LookPath("cargo"); err == nil {
		tc.CargoFound = true
		tc.CargoPath = path
		if out, err := exec.Command(path, "--version").Output(); err == nil {
			tc.CargoVersion = firstLine(string(out))
		}
	}
	if tc.CargoFound {
		// `cargo tauri --version` is how the CLI reports itself once
		// installed as a cargo subcommand; it exits nonzero (and cargo
		// prints "no such subcommand") when it is not installed.
		if out, err := exec.Command(tc.CargoPath, "tauri", "--version").Output(); err == nil {
			tc.TauriCLIFound = true
			tc.TauriCLIVersion = firstLine(string(out))
		}
	}
	return tc
}

// Decision is Resolve's answer: whether to run, and if not, whether that is
// a skip or a failure, and why.
type Decision struct {
	Run    bool
	Fail   bool
	Reason string
}

// Resolve turns desktop.enabled plus what was actually detected into a
// decision, matching Exit Criterion 1 exactly: "passes where the toolchain
// exists, and skips with a clear recorded reason where it does not -- never
// a red build on a machine without cargo." That criterion is also explicit
// that enabled: true inverts this -- a missing toolchain there is a
// deliberate opt-in to strictness, and must fail cleanly rather than skip.
func Resolve(enabled string, tc Toolchain) Decision {
	switch enabled {
	case "false":
		return Decision{Run: false, Reason: "desktop.enabled is false"}
	case "true":
		if !tc.CargoFound {
			return Decision{Run: false, Fail: true,
				Reason: "desktop.enabled is true but cargo was not found on PATH -- " +
					"install the Rust toolchain, or set desktop.enabled: auto to skip instead of failing"}
		}
		if !tc.TauriCLIFound {
			return Decision{Run: false, Fail: true,
				Reason: "desktop.enabled is true but the Tauri CLI is not installed " +
					"(`cargo tauri --version` failed) -- run `cargo install tauri-cli`, " +
					"or set desktop.enabled: auto to skip instead of failing"}
		}
		return Decision{Run: true}
	default: // "auto" and "" (the config default) behave identically.
		if !tc.CargoFound {
			return Decision{Run: false,
				Reason: "cargo not found on PATH; desktop.enabled=auto skips cleanly " +
					"(set desktop.enabled: true to make a missing toolchain a hard failure instead)"}
		}
		if !tc.TauriCLIFound {
			return Decision{Run: false,
				Reason: "cargo is present but the Tauri CLI is not (`cargo tauri --version` failed); " +
					"desktop.enabled=auto skips cleanly -- run `cargo install tauri-cli` to close this"}
		}
		return Decision{Run: true}
	}
}

func firstLine(s string) string {
	if i := strings.IndexByte(s, '\n'); i >= 0 {
		s = s[:i]
	}
	return strings.TrimSpace(s)
}

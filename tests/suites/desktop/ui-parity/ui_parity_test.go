// Package ui_parity_test covers Exit Criterion 6: "smoke UI specs pass
// against the desktop webview."
//
// This is a deliberately narrow scaffold, not a working implementation --
// see docs/testing/progress/phase-06-desktop.md's divergences for why.
// Three separate pieces of unverifiable-here machinery would be needed to
// really close this:
//
//  1. A Playwright-native way to select a "smoke" subset of
//     tests/ui/specs/**. None exists today (Phase 5's Explore survey found
//     no {tag: '@smoke'} anywhere in the UI suite); "smoke" is currently
//     only a Go-harness Tags() concept, which Playwright specs never go
//     through.
//  2. selector.go routing a desktop/ui-parity invocation to Playwright.
//     Today selector.goInvocation/playwrightInvocation split purely on
//     `surface == "ui"`; desktop always becomes a `go test` invocation.
//  3. A Playwright project using connectOverCDP against the Tauri webview
//     this test would have launched, which needs a live desktop app --
//     unreachable without cargo, which is what would let (1) and (2) be
//     verified in the first place.
//
// Writing all three blind, with no way to run or debug any of them on
// this machine, would produce code that looks like a feature and has
// never actually run -- worse than an honest gap. This test records the
// gap and the toolchain check instead.
package ui_parity_test

import (
	"testing"

	"amiro/tests/harness"
	"amiro/tests/harness/desktop"
)

func TestUIParity_SmokeSpecsPassAgainstTheDesktopWebview(t *testing.T) {
	h := harness.New(t, harness.NoBackend(), harness.Tags("smoke"))
	desktop.RequireToolchain(h, h.Config.Desktop.Enabled)
	h.Skip("cargo and the Tauri CLI were detected, but ui-parity is not implemented beyond the " +
		"toolchain check -- see the package doc comment for the three pieces (Playwright smoke " +
		"tagging, selector.go routing, a CDP-connected Playwright project) that would need to exist " +
		"first, none of which could be built and verified on a machine without the toolchain")
}

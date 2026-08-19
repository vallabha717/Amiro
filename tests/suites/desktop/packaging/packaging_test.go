// Package packaging_test covers the "packaging" feature: "`tauri build`
// produces an installer; it installs; the installed app launches and its
// sidecar starts." Tagged slow per the phase doc, and out of the default
// run for that reason independent of the toolchain check.
//
// There is no cargo-free equivalent here, unlike every other feature
// directory in this surface: producing and installing a real platform
// installer is not something any amount of stubbing can substitute for.
package packaging_test

import (
	"testing"

	"amiro/tests/harness"
	"amiro/tests/harness/desktop"
)

func TestPackaging_TauriBuildProducesAWorkingInstalledApp(t *testing.T) {
	h := harness.New(t, harness.NoBackend(), harness.Tags("slow"))
	desktop.RequireToolchain(h, h.Config.Desktop.Enabled)
	h.Skip("reached only with cargo and the Tauri CLI present -- `tauri build` plus installing and " +
		"launching the result is not implemented beyond the toolchain check, since it was never " +
		"runnable here; closing this needs a machine with the Rust toolchain and the platform " +
		"bundler (e.g. dpkg/appimage on Linux) both present")
}

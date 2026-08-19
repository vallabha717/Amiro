package desktop

import "amiro/tests/harness"

// RequireToolchain is the one call every desktop test that genuinely needs
// cargo and the Tauri CLI makes before doing anything else. It skips (via
// h.Skip, which records the reason -- see that method's doc comment for
// why a bare t.Skip here would lose it) when the toolchain is absent and
// desktop.enabled allows skipping, fails cleanly when desktop.enabled:
// true demands the toolchain and it is missing, and otherwise returns the
// detected Toolchain for the caller to use.
//
// Tests that need only the Go sidecar directly -- orphans, most of data,
// the CORS half of webview -- do not call this: they are not gated on
// cargo at all, because nothing about them touches Tauri or Rust.
func RequireToolchain(h *harness.Harness, enabled string) Toolchain {
	h.T.Helper()
	tc := DetectToolchain()
	d := Resolve(enabled, tc)
	if d.Fail {
		h.T.Fatalf("%s", d.Reason)
	}
	if !d.Run {
		h.Skip(d.Reason)
	}
	return tc
}

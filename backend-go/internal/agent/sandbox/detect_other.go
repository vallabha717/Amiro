//go:build !linux && !darwin

package sandbox

// detectForPlatform always returns nil on Windows and any other platform
// this phase does not build a backend for.
//
// This is deliberate, not an oversight: job-object isolation on Windows is
// real, separate work (process/job isolation, not a config flag), named as
// a non-goal for this phase in
// docs/coding-agent-parity/00-overview.md and
// docs/coding-agent-parity/03-sandboxed-execution.md's platform table.
// Returning nil here means Detect() falls through to noneBackend and every
// run_shell result on Windows honestly reports Sandboxed: false, rather
// than this phase silently shipping Windows as equivalent to Linux/macOS
// when it is not.
func detectForPlatform() Backend {
	return nil
}

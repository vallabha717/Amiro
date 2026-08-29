//go:build linux

package sandbox

// detectForPlatform tries bubblewrap on Linux. Windows and any other
// platform have their own file (detect_other.go) that always returns nil
// -- see that file's doc comment for why "documented" beats "silently
// absent" here.
func detectForPlatform() Backend {
	return detectBubblewrap()
}

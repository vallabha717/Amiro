//go:build darwin

package sandbox

// detectForPlatform tries sandbox-exec on macOS.
func detectForPlatform() Backend {
	return detectSeatbelt()
}

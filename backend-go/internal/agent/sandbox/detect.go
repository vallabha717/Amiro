package sandbox

import (
	"sync"
)

// Detect returns the process's sandbox backend, probing exactly once and
// caching the result for the process lifetime -- the same shape
// internal/agent/lsp/registry.go's Available/NewPool uses: opportunistic,
// checked once, and the absence of the capability is a first-class, tested
// outcome (noneBackend) rather than a silent downgrade discovered only when
// a call unexpectedly fails.
//
// Re-probing per command would be both slow (a real subprocess smoke test
// every call) and pointless: bwrap/sandbox-exec do not appear or disappear
// mid-session any more than a language server does.
func Detect() Backend {
	detectOnce.Do(func() {
		detected = detectForPlatform()
		if detected == nil {
			detected = noneBackend{}
		}
	})
	return detected
}

var (
	detectOnce sync.Once
	detected   Backend
)

// resetForTest clears the cached detection so a test can force a fresh
// probe (e.g. after temporarily hiding bwrap from PATH). Test-only: no
// production caller has a reason to re-detect mid-process.
func resetForTest() {
	detectOnce = sync.Once{}
	detected = nil
}

// forceBackendForTest pins Detect()'s cached result to b, bypassing
// platform probing entirely. Used by
// TestSandbox_FallsThroughToUnsandboxedAndSaysSo to exercise the "no
// backend available" path deterministically, on any machine, regardless
// of whether bwrap/sandbox-exec happen to be installed here.
func forceBackendForTest(b Backend) {
	detectOnce.Do(func() {})
	detected = b
}

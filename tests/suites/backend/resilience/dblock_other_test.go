//go:build !unix

package resilience_test

import "errors"

// lockDatabaseFile has no portable equivalent on this platform. The caller
// records a skip with this reason rather than pretending the case ran --
// a silent pass on a case that never executed is the outcome this test
// system exists to prevent.
func lockDatabaseFile(_ string) (func(), error) {
	return nil, errors.New("holding an exclusive advisory lock on a sqlite file needs fcntl, which this platform does not provide")
}

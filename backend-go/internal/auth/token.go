package auth

import (
	"crypto/rand"
	"encoding/hex"
	"time"
)

// SessionTTL is how long an issued session stays valid. Both deploy targets
// use the same value -- plan section 3's resolved decision is one shared
// session model, not a forked "desktop mode" with different lifetimes.
const SessionTTL = 30 * 24 * time.Hour

func newSessionToken() (string, error) {
	b := make([]byte, 32)
	if _, err := rand.Read(b); err != nil {
		return "", err
	}
	return hex.EncodeToString(b), nil
}

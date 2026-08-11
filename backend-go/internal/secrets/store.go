// Package secrets stores and retrieves provider API keys. Plan section 3 is
// explicit that this is never a DB column in either deploy target -- the
// desktop build uses the OS keychain, a web deployment uses
// environment/secret-manager config. This mirrors a real gotcha already
// caught in this workspace's sibling project (Vega.AI, see this
// repo's docs/desktop-rewrite-go-rust-plan.md §3): a live plaintext API key
// left sitting in a config table there.
package secrets

import "context"

// KeyStore is implemented by both deploy targets' backend.
type KeyStore interface {
	// Get returns the stored key for provider, or ok=false if none is set.
	Get(ctx context.Context, provider string) (key string, ok bool, err error)
	Set(ctx context.Context, provider, key string) error
	Delete(ctx context.Context, provider string) error
}

// New picks the deploy-target-appropriate KeyStore: the OS keychain for
// desktop (sqlite driver), environment variables for a web deployment
// (postgres driver) -- same split point internal/db.DialectSQLite/Postgres
// already draws elsewhere, passed in as a bool here rather than importing
// internal/db so this package stays a leaf with no DB dependency.
func New(desktop bool) KeyStore {
	if desktop {
		return NewKeyringStore()
	}
	return NewEnvStore()
}

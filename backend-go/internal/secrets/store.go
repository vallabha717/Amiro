// Package secrets stores and retrieves provider API keys. Plan section 3 is
// explicit that this is never a DB column in either deploy target -- the
// desktop build uses the OS keychain, a web deployment uses
// environment/secret-manager config. This mirrors a real gotcha already
// caught in this workspace's sibling project (Vega.AI, see this
// repo's docs/desktop-rewrite-go-rust-plan.md §3): a live plaintext API key
// left sitting in a config table there.
package secrets

import "context"

// GitHubTokenKey is the KeyStore key a GitHub personal access token is
// stored under -- docs/coding-agent-parity/04-git-remote-operations.md's
// "own storage key, not folded into the provider-key store". A provider
// key controls model spend; this controls write access to a user's
// repositories, so it gets its own entry in the same store rather than
// reusing a provider slug.
const GitHubTokenKey = "github_token"

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
func New(desktop bool, appDataDir string) KeyStore {
	if desktop {
		return NewKeyringStore(appDataDir)
	}
	return NewEnvStore()
}

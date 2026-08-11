package secrets

import (
	"context"
	"errors"
	"os"
	"strings"
)

// ErrReadOnly is returned by EnvStore.Set/Delete: a running process cannot
// durably rewrite its own deploy environment, so a web deployment's keys
// are provisioned out-of-band (the platform's secret manager / env config),
// never through this app at runtime.
var ErrReadOnly = errors.New("secrets: env-backed key store is read-only, configure provider keys via deploy environment/secret manager")

// providerEnvVar overrides the mechanical "<PROVIDER>_API_KEY" pattern for
// providers whose established .env var name doesn't match it -- checked
// against this repo's own .env.example rather than assumed.
var providerEnvVar = map[string]string{
	"google": "GOOGLE_GENERATIVE_AI_API_KEY",
}

func envVarForProvider(provider string) string {
	if v, ok := providerEnvVar[strings.ToLower(provider)]; ok {
		return v
	}
	return strings.ToUpper(provider) + "_API_KEY"
}

// EnvStore is the web-deployment KeyStore: keys come from whatever set the
// process environment (platform secret manager, container env, etc), read
// only, per plan section 3.
type EnvStore struct{}

func NewEnvStore() *EnvStore { return &EnvStore{} }

func (EnvStore) Get(_ context.Context, provider string) (string, bool, error) {
	key := os.Getenv(envVarForProvider(provider))
	if key == "" {
		return "", false, nil
	}
	return key, true, nil
}

func (EnvStore) Set(_ context.Context, _, _ string) error {
	return ErrReadOnly
}

func (EnvStore) Delete(_ context.Context, _ string) error {
	return ErrReadOnly
}

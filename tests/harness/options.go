package harness

import (
	"amiro/tests/harness/config"
	"amiro/tests/harness/fakeprovider"
	"amiro/tests/harness/seed"
)

// Option customises one test's harness.
type Option func(*options)

type options struct {
	tags      []string
	noSeed    bool
	seeds     []seed.Seed
	overrides []config.Override
	surface   string
	feature   string
	buildTags []string
	noBackend bool
	cassetteName string
	fakeConfig   func(*fakeprovider.Server)
}

// WithCassette names the preferred cassette to replay for this test.
func WithCassette(name string) Option {
	return func(o *options) { o.cassetteName = name }
}

// StrictCassettes forces this test to fail immediately on any cassette miss.
func StrictCassettes() Option {
	return func(o *options) {
		o.overrides = append(o.overrides, func(c *config.Config) {
			c.Run.StrictCassettes = true
		})
	}
}

// ProviderMode overrides the provider mode ("fake", "replay", "record", "live") for this test.
func ProviderMode(mode string) Option {
	return func(o *options) {
		o.overrides = append(o.overrides, func(c *config.Config) {
			c.Providers.Mode = mode
		})
	}
}

// WithFake configures declarative responses on the test's fakeprovider.
func WithFake(fn func(*fakeprovider.Server)) Option {
	return func(o *options) { o.fakeConfig = fn }
}

// Tags declares cross-cutting properties of a test: smoke, live, slow,
// flaky, destructive.
//
// A tag is a harness call rather than a Go build tag so that it
// participates in the same selection logic as everything else -- build tags
// would need a separate `go test -tags` invocation per combination, and
// `amirotest run --tag smoke` could not span surfaces.
//
// New() SKIPS the test, with a recorded reason, when the current selection
// excludes any of these. A skip with no reason is a silent pass, which is
// how a suite reports green while running nothing.
func Tags(tags ...string) Option {
	return func(o *options) { o.tags = append(o.tags, tags...) }
}

// NoSeed starts against a genuinely empty database.
//
// Needed by tests about first-run behaviour: the first registered account
// becoming admin, the onboarding flow, /api/auth/status. Those cannot run
// against a seeded database by definition.
func NoSeed() Option {
	return func(o *options) { o.noSeed = true }
}

// Seeds adds fixtures beyond the default accounts.
func Seeds(s ...seed.Seed) Option {
	return func(o *options) { o.seeds = append(o.seeds, s...) }
}

// With overrides configuration for this test only. The override is recorded
// in the test's summary entry, so a result never depends on config that
// cannot be seen from the artifacts.
func With(fn func(*config.Config)) Option {
	return func(o *options) { o.overrides = append(o.overrides, config.Override(fn)) }
}

// Surface and Feature override what New() derives from the test file's
// path. Only needed where a test genuinely lives outside the addressing
// convention -- suites/meta, which tests the test system itself.
func Surface(name string) Option { return func(o *options) { o.surface = name } }
func Feature(name string) Option { return func(o *options) { o.feature = name } }

// BuildTags are passed to `go build` for this test's backend. The UI
// surface needs "embedui" so `amiro serve` has a dashboard inside it.
func BuildTags(tags ...string) Option {
	return func(o *options) { o.buildTags = append(o.buildTags, tags...) }
}

// NoBackend skips starting a server.
//
// For tests that only need the run directory and the resolved config --
// suites/meta's guards, and anything asserting on the harness itself.
// Starting a backend for those would add ~2s each and prove nothing.
func NoBackend() Option {
	return func(o *options) { o.noBackend = true }
}


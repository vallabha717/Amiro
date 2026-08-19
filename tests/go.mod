// Module amiro/tests is the root test system: the harness every suite
// imports, the `amirotest` CLI, and the suites themselves.
//
// It is deliberately a SEPARATE module from amiro/backend, and it does not
// depend on it. Two reasons, one by choice and one by the language:
//
//   - By choice: test-only dependencies (PTY drivers, cassette libraries,
//     Playwright) must never enter the shipped binary's dependency graph,
//     and nothing here should be able to assert on implementation detail.
//
//   - By the language: Go forbids importing amiro/backend/internal/... from
//     outside the tree rooted at backend-go/. The plan's `replace` directive
//     was written expecting to reuse internal/ai/uimessage and
//     internal/appwiring; neither is reachable. Both are small and are
//     transcribed instead -- see harness/apiclient/stream.go and
//     harness/backend/lock.go, which each carry a pointer back to the
//     original and a test that fails if the wire format drifts.
//
// The consequence is a module with no `require` on the app at all: the test
// system talks to Amiro over HTTP, a PTY, and a browser, exactly as a user
// does.
module amiro/tests

go 1.26.5

require (
	github.com/creack/pty v1.1.24
	github.com/jackc/pgx/v5 v5.10.0
	gopkg.in/yaml.v3 v3.0.1
)

require (
	github.com/jackc/pgpassfile v1.0.0 // indirect
	github.com/jackc/pgservicefile v0.0.0-20240606120523-5a60cdf6a761 // indirect
	github.com/jackc/puddle/v2 v2.2.2 // indirect
	github.com/kr/text v0.2.0 // indirect
	github.com/rogpeppe/go-internal v1.16.0 // indirect
	golang.org/x/sync v0.17.0 // indirect
	golang.org/x/text v0.29.0 // indirect
)

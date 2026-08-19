//go:build !embedui

package web

import "io/fs"

// embedded reports that this binary carries no dashboard bundle.
//
// The default build deliberately does not embed one. go:embed resolves at
// compile time against files that only exist after `pnpm build` plus
// scripts/build-ui.sh, so making it unconditional would mean a fresh
// clone could not `go build ./...` until someone had installed Node and
// run a frontend build -- a Go contributor would hit a TypeScript-shaped
// wall on their first command. Release builds pass -tags embedui; every
// other build gets a working binary that serves the API and says plainly
// that it has no UI.
func embedded() (fs.FS, bool) { return nil, false }

package main

import (
	"fmt"

	"amiro/backend/internal/web"
)

// version is overridden at release-build time via
// -ldflags "-X main.version=...". "dev" for a plain `go build`.
var version = "dev"

// printVersion reports the dashboard bundle alongside the binary's own
// version, because "which UI is inside this binary" is a real and
// otherwise unanswerable question: the bundle is compiled in from
// whatever internal/web/dist happened to hold at build time, and a stale
// one looks identical from the outside. The build id is a hash of the
// bundle's contents (web.Handler.BuildID), so two binaries carrying the
// same UI report the same id.
func printVersion() {
	fmt.Println("amiro " + version)
	if h, ok := web.New(); ok {
		fmt.Println("dashboard " + h.BuildID())
	} else {
		fmt.Println("dashboard (not embedded -- built without -tags embedui)")
	}
}

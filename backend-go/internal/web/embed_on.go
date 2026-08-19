//go:build embedui

package web

import (
	"embed"
	"io/fs"
)

// dist holds the exported Next.js bundle, populated by
// scripts/build-ui.sh before a release build. The "all:" prefix matters:
// without it go:embed silently skips files whose names begin with "_",
// and a Next.js export puts every JavaScript chunk, stylesheet and font
// under _next/ -- the bundle would compile in as HTML with no assets.
//
//go:embed all:dist
var dist embed.FS

func embedded() (fs.FS, bool) {
	sub, err := fs.Sub(dist, "dist")
	if err != nil {
		return nil, false
	}
	return sub, true
}

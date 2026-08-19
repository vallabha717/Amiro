package main

import (
	"flag"
	"fmt"
	"os"
	"strings"

	"amiro/tests/harness/config"
	"amiro/tests/harness/selector"
)

// listFlag collects a repeatable, comma-separated flag.
type listFlag []string

func (l *listFlag) String() string { return strings.Join(*l, ",") }
func (l *listFlag) Set(v string) error {
	*l = append(*l, config.SplitList(v)...)
	return nil
}

// commonFlags are shared by every command that resolves configuration.
type commonFlags struct {
	configPath string
	baseDir    string
}

func (c *commonFlags) register(fs *flag.FlagSet) {
	fs.StringVar(&c.configPath, "config", "", "use this config file instead of tests/config.yaml")
	fs.StringVar(&c.baseDir, "dir", "", "the tests/ directory (default: discovered by walking up)")
}

// selectionFlags are the surface/feature/grep/tag set.
type selectionFlags struct {
	surfaces listFlag
	features listFlag
	grep     string
	tags     listFlag
	browsers listFlag
}

func (s *selectionFlags) register(fs *flag.FlagSet) {
	fs.Var(&s.surfaces, "surface", "surface(s) to run: backend, tui, ui, desktop, cross, meta")
	fs.Var(&s.features, "feature", "feature(s) to run; with no --surface, runs that feature on every surface")
	fs.StringVar(&s.grep, "grep", "", "narrow to test names matching this pattern")
	fs.Var(&s.tags, "tag", "run only tests carrying these tags")
	fs.Var(&s.browsers, "browser", "browser project(s) for the ui surface")
}

// apply folds the selection flags into the resolved configuration.
//
// A flag is an OVERRIDE of the corresponding config key, not an
// intersection with it: `--surface ui` on a config listing all four
// surfaces runs only the UI. Intersection semantics would make a flag
// unable to widen a narrow config, which is the opposite of what a
// command-line override is for.
func (s *selectionFlags) apply(cfg *config.Config) {
	if len(s.surfaces) > 0 {
		cfg.Run.Surfaces = s.surfaces
	}
	if len(s.features) > 0 {
		cfg.Run.Features = s.features
	}
	if len(s.browsers) > 0 {
		cfg.UI.Browsers = s.browsers
	}
	if len(s.tags) > 0 {
		cfg.Run.Tags.Include = s.tags
		// Asking for a tag plainly means wanting it. Leaving `slow` in the
		// default exclusion while it is also required would produce a run
		// that selects nothing and reports success -- the single worst
		// outcome a test system can produce.
		cfg.Run.Tags.Exclude = without(cfg.Run.Tags.Exclude, s.tags)
	}
}

func without(list, remove []string) []string {
	out := list[:0:0]
	for _, v := range list {
		drop := false
		for _, r := range remove {
			if v == r {
				drop = true
				break
			}
		}
		if !drop {
			out = append(out, v)
		}
	}
	return out
}

func (s *selectionFlags) selection(cfg *config.Config) selector.Selection {
	return selector.Selection{
		Surfaces:    cfg.Run.Surfaces,
		Features:    cfg.Run.Features,
		Grep:        s.grep,
		TagsInclude: cfg.Run.Tags.Include,
		TagsExclude: cfg.Run.Tags.Exclude,
		Browsers:    cfg.UI.Browsers,
	}
}

// loadConfig resolves the full precedence chain and reports validation
// errors the way docs/testing/02-config.md specifies: all of them at once,
// with nothing spawned.
func loadConfig(common commonFlags, overrides ...config.Override) (*config.Result, int) {
	res, err := config.Load(config.LoadOptions{
		BaseDir:   common.baseDir,
		File:      common.configPath,
		Overrides: overrides,
	})
	if err != nil {
		var ve *config.ValidationError
		if asValidation(err, &ve) {
			fmt.Fprintf(os.Stderr, "amirotest: %s\n\nNothing was run. Every key in config.yaml is optional -- "+
				"deleting the offending line is always a valid fix.\n", ve.Error())
			return nil, exitConfig
		}
		fmt.Fprintf(os.Stderr, "amirotest: %v\n", err)
		return nil, exitConfig
	}
	for _, w := range res.Warnings {
		fmt.Fprintf(os.Stderr, "warning: %s\n", w.String())
	}
	return res, exitOK
}

func asValidation(err error, target **config.ValidationError) bool {
	for err != nil {
		if v, ok := err.(*config.ValidationError); ok {
			*target = v
			return true
		}
		u, ok := err.(interface{ Unwrap() error })
		if !ok {
			return false
		}
		err = u.Unwrap()
	}
	return false
}

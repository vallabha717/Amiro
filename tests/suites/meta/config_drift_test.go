// Package meta_test holds the guards: tests OF the test system rather than
// of Amiro.
//
// They exist because every property this suite relies on -- honest
// defaults, no leaked secrets, no orphaned processes, no reaching into the
// application's internals -- degrades silently. A guard turns each one from
// a convention someone has to remember into a build failure.
package meta_test

import (
	"os"
	"path/filepath"
	"reflect"
	"testing"

	"amiro/tests/harness"
	"amiro/tests/harness/config"
)

// TestConfigExample_MatchesTheDefaults is the drift guard.
//
// config.example.yaml is generated from harness/config/defaults.go. The
// usual way a config file's comments become lies is that somebody changes a
// default and nobody regenerates the template; this fails the build instead.
func TestConfigExample_MatchesTheDefaults(t *testing.T) {
	h := harness.New(t, harness.NoBackend(), harness.Tags("smoke"))

	path := filepath.Join(h.BaseDir, config.ExampleName)
	committed, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("reading %s: %v\nRun `go run ./cmd/amirotest config example`.", path, err)
	}
	generated := config.Example()
	if string(committed) == generated {
		return
	}
	t.Fatalf("%s has drifted from harness/config/defaults.go.\n"+
		"Run `go run ./cmd/amirotest config example` and commit the result.\n\n%s",
		path, firstDifference(string(committed), generated))
}

// TestConfigExample_ParsesBackToExactlyTheDefaults is the stronger half.
//
// Matching the generator only proves the file is what the generator emits.
// This proves the file is a VALID configuration that resolves to the very
// defaults it documents -- so "delete config.yaml" and "copy the example
// verbatim" genuinely produce the same run, which is what
// docs/testing/02-config.md promises.
func TestConfigExample_ParsesBackToExactlyTheDefaults(t *testing.T) {
	h := harness.New(t, harness.NoBackend(), harness.Tags("smoke"))

	res, err := config.Load(config.LoadOptions{
		BaseDir: h.BaseDir,
		File:    filepath.Join(h.BaseDir, config.ExampleName),
		EnvFile: os.DevNull,
		SkipEnv: true,
	})
	if err != nil {
		t.Fatalf("config.example.yaml does not load cleanly: %v", err)
	}
	want := config.Defaults()
	if !reflect.DeepEqual(res.Config, want) {
		t.Fatalf("loading config.example.yaml does not reproduce Defaults().\n"+
			"A key in the file documents a value the code does not actually use.\n\ngot:  %+v\n\nwant: %+v",
			res.Config, want)
	}
}

// TestConfig_MissingFileIsAValidConfiguration is the core promise, asserted
// rather than assumed: no config.yaml, no .env, no environment, and the
// result is a usable configuration with no errors.
//
// If this ever fails, a new contributor's first command fails, and so does
// CI, and so does any agent working in this repository without credentials.
func TestConfig_MissingFileIsAValidConfiguration(t *testing.T) {
	h := harness.New(t, harness.NoBackend(), harness.Tags("smoke"))

	res, err := config.Load(config.LoadOptions{
		BaseDir:   h.BaseDir,
		File:      filepath.Join(t.TempDir(), "definitely-absent.yaml"),
		LocalFile: filepath.Join(t.TempDir(), "definitely-absent.local.yaml"),
		EnvFile:   os.DevNull,
		SkipEnv:   true,
	})
	if err != nil {
		t.Fatalf("a missing config.yaml must be a valid configuration, but: %v", err)
	}
	if len(res.Sources) != 0 {
		t.Errorf("no config file should have been read, but sources are %v", res.Sources)
	}
	if res.Config.Providers.Mode != "replay" {
		t.Errorf("default providers.mode is %q, expected \"replay\"", res.Config.Providers.Mode)
	}
	if len(res.Config.Providers.LLM) != 0 {
		t.Errorf("no providers should be configured without a config file, got %d", len(res.Config.Providers.LLM))
	}
}

func firstDifference(a, b string) string {
	aLines, bLines := splitLines(a), splitLines(b)
	for i := 0; i < len(aLines) || i < len(bLines); i++ {
		var x, y string
		if i < len(aLines) {
			x = aLines[i]
		}
		if i < len(bLines) {
			y = bLines[i]
		}
		if x != y {
			return "first difference at line " + itoa(i+1) + ":\n  committed: " + x + "\n  generated: " + y
		}
	}
	return "the files differ only in trailing content"
}

func splitLines(s string) []string {
	var out []string
	start := 0
	for i := 0; i < len(s); i++ {
		if s[i] == '\n' {
			out = append(out, s[start:i])
			start = i + 1
		}
	}
	return append(out, s[start:])
}

func itoa(n int) string {
	if n == 0 {
		return "0"
	}
	var buf [20]byte
	i := len(buf)
	for n > 0 {
		i--
		buf[i] = byte('0' + n%10)
		n /= 10
	}
	return string(buf[i:])
}

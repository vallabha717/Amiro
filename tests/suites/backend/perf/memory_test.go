package perf_test

import (
	"fmt"
	"strings"
	"testing"

	"amiro/tests/harness"
	"amiro/tests/harness/apiclient"
	"amiro/tests/harness/fakeprovider"
)

// TestPerf_MemoryAfter100Turns is "Memory after 100 turns | < 500MB RSS,
// and not monotonically growing".
//
// Two separate claims, asserted separately:
//
//   - the level: final RSS under 500MB. Recorded on the trend, in MB.
//   - the shape: not monotonically growing. A process whose RSS rises at
//     every single sample across a hundred turns is leaking, whatever the
//     absolute number happens to be, and the absolute number is exactly
//     the thing that is fine right up until it is not.
//
// RSS comes from /proc/<pid>/status's VmRSS line, read against the pid
// harness/backend exposes through Backend.Process().Pid(). harness/process
// has no RSS accessor and this is the only budget that wants one, so the
// reader lives here (budget_test.go's rssBytes) rather than being pushed
// into the harness for one caller. It is Linux-only and the test skips
// with a recorded reason elsewhere.
//
// The shape assertion is deliberately loose. Go's allocator returns memory
// to the OS lazily, so a genuinely healthy server can still show a
// slightly rising RSS across ten samples; failing on that would make this
// a flake generator, which is the specific outcome the phase document
// warns about ("machine variance would make them a flake source"). The bar
// is therefore: strictly rising at EVERY sample AND having grown by more
// than growthTolerance over the run. Either alone is normal; both together
// is a leak.
func TestPerf_MemoryAfter100Turns(t *testing.T) {
	const turns = 100
	const sampleEvery = 10
	// growthTolerance is how much total growth a strictly-rising series is
	// allowed before it counts as a leak. 25% of the first sample is well
	// inside what lazy scavenging explains and well outside what a hundred
	// turns' worth of retained per-turn state would look like.
	const growthTolerance = 0.25

	h := harness.New(t, harness.Tags("slow"))
	requireLinux(h, "the memory budget")

	user := h.As("user")
	be := h.Backend()
	pid := be.Process().Pid()
	if pid == 0 {
		t.Fatal("the backend reports no pid, so its RSS cannot be read")
	}

	h.Fake().OnAny().StreamText(
		"A reply long enough that the turn does real framing work rather than none at all.",
		fakeprovider.PerChunk(8))

	type point struct {
		turn  int
		bytes int64
	}
	var samples []point

	sample := func(turn int) {
		t.Helper()
		rss, err := rssBytes(pid)
		if err != nil {
			t.Fatalf("reading RSS after turn %d: %v", turn, err)
		}
		samples = append(samples, point{turn: turn, bytes: rss})
	}

	sample(0)
	for i := 1; i <= turns; i++ {
		req := apiclient.ChatRequest{
			ID:      fmt.Sprintf("thread-perf-memory-%03d", i),
			Message: apiclient.TextMessage(fmt.Sprintf("msg-%03d", i), fmt.Sprintf("memory budget turn %d", i)),
		}
		if _, err := user.ChatTurn(h.Ctx, req); err != nil {
			t.Fatalf("turn %d: %v", i, err)
		}
		if i%sampleEvery == 0 {
			sample(i)
		}
	}

	var rendered []string
	for _, s := range samples {
		rendered = append(rendered, fmt.Sprintf("turn %3d: %.1fMB", s.turn, float64(s.bytes)/(1<<20)))
	}
	t.Logf("RSS samples across %d turns:\n  %s", turns, strings.Join(rendered, "\n  "))

	final := samples[len(samples)-1]
	first := samples[0]

	// Shape: strictly rising at every step?
	strictlyRising := true
	for i := 1; i < len(samples); i++ {
		if samples[i].bytes <= samples[i-1].bytes {
			strictlyRising = false
			break
		}
	}
	growth := float64(final.bytes-first.bytes) / float64(first.bytes)
	if strictlyRising && growth > growthTolerance {
		t.Errorf("backend RSS grew monotonically at every one of %d samples, from %.1fMB to %.1fMB (+%.1f%%), "+
			"across %d turns -- that is the shape of a leak, not of a plateau:\n  %s",
			len(samples), float64(first.bytes)/(1<<20), float64(final.bytes)/(1<<20), growth*100,
			turns, strings.Join(rendered, "\n  "))
	}
	t.Logf("shape: strictlyRising=%v, total growth %+.1f%% (tolerance %.0f%%)",
		strictlyRising, growth*100, growthTolerance*100)

	// Level: the recorded, asserted, trended number.
	record(h, sample_(budgetMemoryRSS,
		float64(final.bytes)/(1<<20),
		float64(limitMemoryRSSBytes)/(1<<20),
		fmt.Sprintf("VmRSS of the cmd/server process after %d fakeprovider chat turns; "+
			"shape check over %d samples reported strictlyRising=%v, growth %+.1f%%",
			turns, len(samples), strictlyRising, growth*100)))
}

// sample_ builds a non-duration sample. Named with a trailing underscore
// only because `sample` is already the type; the alternative was renaming
// the type, which reads worse in the trend file's schema.
func sample_(budget string, value, limit float64, note string) sample {
	return sample{Budget: budget, Value: value, Unit: "MB", Limit: limit, Note: note}
}

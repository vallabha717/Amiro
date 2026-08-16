package uimessage

import (
	"strings"
	"testing"
	"time"
)

// newTestSmoother returns a Smoother whose sleeps are recorded instead of
// actually taken, so pacing behaviour is testable without real time.
func newTestSmoother() (*Smoother, *[]string, *[]time.Duration) {
	var emitted []string
	var slept []time.Duration
	s := NewSmoother(func(frag string) error {
		emitted = append(emitted, frag)
		return nil
	})
	s.sleep = func(d time.Duration) { slept = append(slept, d) }
	return s, &emitted, &slept
}

// The whole point: rejoining every emitted fragment must reproduce the
// model's text byte for byte, whitespace included.
func TestSmoother_PreservesTextExactly(t *testing.T) {
	for _, input := range []string{
		"The sea is calm tonight.",
		"one\ntwo\n\nthree   four\t five",
		"trailing space ",
		" leading space",
		"nowhitespaceatall",
	} {
		s, emitted, _ := newTestSmoother()
		// Feed it in awkward slices to mimic provider chunking.
		for i := 0; i < len(input); i += 3 {
			end := i + 3
			if end > len(input) {
				end = len(input)
			}
			s.Write(input[i:end])
		}
		s.Flush()

		if got := strings.Join(*emitted, ""); got != input {
			t.Fatalf("round trip = %q, want %q", got, input)
		}
	}
}

// A word must never be split across two frames, or the client renders
// half-words as the reply arrives.
func TestSmoother_NeverSplitsAWordAcrossFrames(t *testing.T) {
	s, emitted, _ := newTestSmoother()
	// "Hello" arrives in three separate provider chunks.
	s.Write("He")
	s.Write("ll")
	s.Write("o world ")
	s.Flush()

	for _, frag := range *emitted {
		trimmed := strings.TrimSpace(frag)
		if trimmed != "" && trimmed != "Hello" && trimmed != "world" {
			t.Fatalf("fragment %q is not a whole word; frames = %q", frag, *emitted)
		}
	}
	if got := strings.Join(*emitted, ""); got != "Hello world " {
		t.Fatalf("round trip = %q", got)
	}
}

// The regression that matters. Found live: a gateway streamed a whole reply
// word by word faster than the pacing delay, the sleeps ran on the goroutine
// reading it, and its chunks silently queued up behind us -- 852 words went
// out a dead-flat 10.3ms apart and the reply took 8.5 seconds longer to
// paint than the model took to write. Chunks that are already waiting must
// go out at full speed.
func TestSmoother_AddsNoDelayWhenChunksAreAlreadyQueued(t *testing.T) {
	s, emitted, slept := newTestSmoother()

	// One word per chunk with no wait between them: exactly what a provider
	// running ahead of us looks like from inside Write.
	for i := 0; i < 200; i++ {
		s.Write("word ")
	}
	s.Flush()

	var total time.Duration
	for _, d := range *slept {
		total += d
	}
	if total > 5*time.Millisecond {
		t.Fatalf("slept %v in total across 200 queued words, want ~none", total)
	}
	if len(*emitted) != 200 {
		t.Fatalf("emitted %d fragments, want 200", len(*emitted))
	}
}

// A burst is smoothed into a fast sweep, never replayed in slow motion: a
// provider that buffers the whole reply and delivers it in one chunk after
// several seconds must not have that chunk spread across those seconds.
func TestSmoother_SpreadsABurstButNeverOverMaxSpread(t *testing.T) {
	s, _, slept := newTestSmoother()
	s.last = time.Now().Add(-14 * time.Second) // a long, buffered wait

	const words = 500
	s.Write(strings.Repeat("word ", words))
	s.Flush()

	var total time.Duration
	for _, d := range *slept {
		total += d
	}
	if total > maxBurstSpread {
		t.Fatalf("spread the burst over %v, want at most %v", total, maxBurstSpread)
	}
	if total == 0 {
		t.Fatal("expected the burst to be spread at all, got no pacing")
	}
}

// When the provider itself is slower than the ceiling, pacing tracks the
// provider and adds nothing on top of it.
func TestSmoother_PacesAtTheProviderRateWhenItIsSlow(t *testing.T) {
	s, _, slept := newTestSmoother()

	// One word per chunk, the provider taking far longer than the ceiling
	// between them -- the realistic slow-model shape.
	for _, chunk := range []string{"alpha ", "beta ", "gamma "} {
		s.last = time.Now().Add(-time.Second)
		s.Write(chunk)
	}
	s.Flush()

	for _, d := range *slept {
		if d > smootherBaseDelay {
			t.Fatalf("slept %v, want no more than the %v ceiling", d, smootherBaseDelay)
		}
	}
}

func TestSmoother_FlushIsSafeWhenNothingIsBuffered(t *testing.T) {
	s, emitted, _ := newTestSmoother()
	s.Flush()
	s.Write("")
	s.Flush()
	if len(*emitted) != 0 {
		t.Fatalf("emitted %q, want nothing", *emitted)
	}
}

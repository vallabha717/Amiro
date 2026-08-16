package uimessage

import (
	"time"
)

// Smoother evens out a model's text delivery before it reaches the client.
//
// Providers do not stream at a human-readable rate. They emit in bursts --
// a few characters, then nothing for 300ms, then a 200-character paragraph
// in one chunk -- and forwarding that verbatim is what makes a reply look
// like it is stuttering even when total latency is fine. This is the Go
// counterpart of the AI SDK's `smoothStream({chunking: "word"})`, which the
// upstream TypeScript app applies for exactly this reason.
//
// Two properties, both deliberate:
//
//   - It paces by *word*, never splitting one across frames, so the client
//     never renders half a word.
//   - It stretches each arrival over the time that arrival itself took, and
//     never longer. Smoothing spreads a burst; it must never set the pace.
//
// That second property is the whole design, and getting it wrong is not
// subtle. A fixed per-word pause (what smoothStream does, and what this
// originally copied) silently becomes the rate limiter the moment a provider
// streams faster than the pause: the sleeps happen on the goroutine reading
// the provider, so its chunks just queue up behind us, invisibly. Measured
// live against a real gateway: 852 words emitted at a dead-flat 10.3ms
// apart, 100% of gaps pinned to the delay, the model finished long before
// the screen did, and the reply took 8.5 extra seconds to paint. From the
// user's side that reads as the UI hanging -- because it is.
//
// So pacing is derived from the provider's own delivery instead of a
// constant: a chunk that took `gap` to arrive is spread over `gap`, which by
// construction adds no net latency. When chunks are already queued (gap ~0)
// words go out at full speed.
type Smoother struct {
	emit func(string) error
	// buf holds text not yet released: always a partial trailing word, since
	// a word is only releasable once whitespace terminates it. Providers
	// routinely split one word across chunks ("He" then "llo"), so buffering
	// raw text and re-scanning it is the only way to avoid emitting halves.
	buf string
	// last is when the previous word finished going out, so the next Write
	// can tell how long the provider kept us waiting for it.
	last time.Time

	baseDelay time.Duration
	sleep     func(time.Duration)
}

// smootherBaseDelay is the *longest* pause ever placed between two words --
// a ceiling, not a target. Beyond roughly this cadence the eye stops reading
// a stream and starts watching a progress bar.
const smootherBaseDelay = 10 * time.Millisecond

// maxBurstSpread bounds how long one arrival may be stretched over. Without
// it, a provider that buffers an entire reply and delivers it in a single
// chunk after 14 seconds would have that chunk spread across 14 seconds.
// A burst is smoothed into a fast sweep, not replayed in slow motion.
const maxBurstSpread = 250 * time.Millisecond

// NewSmoother returns a Smoother that writes paced fragments via emit.
func NewSmoother(emit func(string) error) *Smoother {
	return &Smoother{emit: emit, baseDelay: smootherBaseDelay, sleep: time.Sleep}
}

// Write buffers a raw provider fragment and releases every whole word it
// completes. A trailing partial word is held back until the next Write (or
// Flush) so words are never split across frames.
func (s *Smoother) Write(delta string) {
	if delta == "" {
		return
	}
	// How long the provider kept us waiting for this chunk. Measured before
	// any of this chunk's own pacing, so it reflects the model's rate and not
	// ours. Near zero means chunks were already queued behind us.
	gap := s.arrivalGap()

	s.buf += delta

	var words []string
	for {
		end := wordEnd(s.buf)
		if end < 0 {
			break
		}
		words = append(words, s.buf[:end])
		s.buf = s.buf[end:]
	}
	if len(words) == 0 {
		return
	}

	perWord := s.pace(gap, len(words))
	for _, w := range words {
		s.release(w, perWord)
	}
}

// arrivalGap is how long it has been since the last word went out. On the
// very first chunk there is no previous word, and the first token must never
// be held back, so the gap is zero.
func (s *Smoother) arrivalGap() time.Duration {
	if s.last.IsZero() {
		return 0
	}
	return time.Since(s.last)
}

// pace spreads a chunk's words across the time the chunk took to arrive,
// bounded at both ends: never more than baseDelay between two words, and
// never stretching one arrival past maxBurstSpread.
func (s *Smoother) pace(gap time.Duration, words int) time.Duration {
	if gap > maxBurstSpread {
		gap = maxBurstSpread
	}
	perWord := gap / time.Duration(words)
	if perWord > s.baseDelay {
		perWord = s.baseDelay
	}
	if perWord < 0 {
		return 0
	}
	return perWord
}

// Flush releases whatever is still buffered, unpaced. Call it when the text
// part ends -- a tool call is about to be written, or the step is over.
func (s *Smoother) Flush() {
	if s.buf == "" {
		return
	}
	_ = s.emit(s.buf)
	s.buf = ""
}

func (s *Smoother) release(word string, perWord time.Duration) {
	if perWord > 0 {
		s.sleep(perWord)
	}
	s.last = time.Now()
	_ = s.emit(word)
}

// wordEnd returns the index just past the first complete word in buf --
// the word's own characters plus the whitespace run that terminates it --
// or -1 when buf does not yet hold a whole word.
//
// Byte-wise rather than rune-wise on purpose: only ASCII whitespace is a
// boundary, and every byte of a multi-byte UTF-8 rune is >= 0x80, so a
// split can never land inside one.
func wordEnd(buf string) int {
	i := 0
	for i < len(buf) && isSpaceByte(buf[i]) {
		i++
	}
	if i == len(buf) {
		return -1 // whitespace only so far; the word itself hasn't arrived
	}
	j := i
	for j < len(buf) && !isSpaceByte(buf[j]) {
		j++
	}
	if j == len(buf) {
		return -1 // no terminator yet -- the rest of this word is still coming
	}
	for j < len(buf) && isSpaceByte(buf[j]) {
		j++
	}
	return j
}

func isSpaceByte(b byte) bool {
	return b == ' ' || b == '\n' || b == '\t' || b == '\r'
}

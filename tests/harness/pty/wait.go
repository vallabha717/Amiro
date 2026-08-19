package pty

import (
	"context"
	"fmt"
	"time"
)

// WaitForStable polls the buffer until it has not changed for quietWindow,
// up to timeout. This is the primary anti-flake synchronization primitive.
func WaitForStable(ctx context.Context, b *Buffer, timeout time.Duration, quietWindow time.Duration) error {
	if quietWindow <= 0 {
		quietWindow = 50 * time.Millisecond
	}
	deadline := time.Now().Add(timeout)
	lastSeq := b.ChangeSeq()
	lastChange := time.Now()
	interval := 10 * time.Millisecond

	for {
		now := time.Now()
		if now.After(deadline) {
			return fmt.Errorf("buffer did not stabilize within %s (last sequence %d)\nscreen:\n%s", timeout, lastSeq, b.Plain())
		}

		currentSeq := b.ChangeSeq()
		if currentSeq != lastSeq {
			lastSeq = currentSeq
			lastChange = now
		} else if now.Sub(lastChange) >= quietWindow {
			return nil // Stable for the quiet window!
		}

		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-time.After(interval):
		}
		if interval < 50*time.Millisecond {
			interval = interval * 3 / 2
		}
	}
}

// WaitForText polls until the buffer's plain text contains substring s.
func WaitForText(ctx context.Context, b *Buffer, s string, timeout time.Duration) error {
	deadline := time.Now().Add(timeout)
	interval := 10 * time.Millisecond

	for {
		if b.Contains(s) {
			return nil
		}
		if time.Now().After(deadline) {
			return fmt.Errorf("timed out after %s waiting for text %q\nlast screen:\n%s", timeout, s, b.Plain())
		}

		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-time.After(interval):
		}
		if interval < 50*time.Millisecond {
			interval = interval * 3 / 2
		}
	}
}

// WaitForFrame polls until predicate returns true or timeout expires.
func WaitForFrame(ctx context.Context, b *Buffer, timeout time.Duration, predicate func(*Buffer) bool) error {
	deadline := time.Now().Add(timeout)
	interval := 10 * time.Millisecond

	for {
		if predicate(b) {
			return nil
		}
		if time.Now().After(deadline) {
			return fmt.Errorf("timed out after %s waiting for frame condition\nlast screen:\n%s", timeout, b.Plain())
		}

		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-time.After(interval):
		}
		if interval < 50*time.Millisecond {
			interval = interval * 3 / 2
		}
	}
}

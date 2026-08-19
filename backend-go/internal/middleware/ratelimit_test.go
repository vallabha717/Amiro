package middleware

import (
	"fmt"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"
)

func limitedHandler(cfg RateLimitConfig) (http.Handler, *int) {
	calls := 0
	next := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		calls++
		w.WriteHeader(http.StatusOK)
	})
	return RateLimit(cfg)(next), &calls
}

func post(h http.Handler, path, remoteAddr string) int {
	req := httptest.NewRequest(http.MethodPost, path, nil)
	req.RemoteAddr = remoteAddr
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)
	return rec.Code
}

func TestRateLimit_AllowsTheBurstThenRefuses(t *testing.T) {
	h, calls := limitedHandler(RateLimitConfig{Burst: 3, Every: time.Minute, Paths: []string{"/api/auth/login"}})

	for i := range 3 {
		if code := post(h, "/api/auth/login", "10.0.0.1:1234"); code != http.StatusOK {
			t.Fatalf("attempt %d: status = %d, want 200 (still inside the burst)", i+1, code)
		}
	}
	if code := post(h, "/api/auth/login", "10.0.0.1:1234"); code != http.StatusTooManyRequests {
		t.Fatalf("attempt 4: status = %d, want %d", code, http.StatusTooManyRequests)
	}
	if *calls != 3 {
		t.Fatalf("handler ran %d times, want 3 -- a refused request must not reach it", *calls)
	}
}

// TestRateLimit_IsPerClient keeps one noisy address from locking everyone
// else out: this guards a shared listener, so a global counter would turn
// a brute-force attempt into a denial of service against the real user.
func TestRateLimit_IsPerClient(t *testing.T) {
	h, _ := limitedHandler(RateLimitConfig{Burst: 2, Every: time.Minute, Paths: []string{"/api/auth/login"}})

	post(h, "/api/auth/login", "10.0.0.1:1111")
	post(h, "/api/auth/login", "10.0.0.1:1111")
	if code := post(h, "/api/auth/login", "10.0.0.1:1111"); code != http.StatusTooManyRequests {
		t.Fatalf("first client should be exhausted, got %d", code)
	}

	// A different port on the same host is the same client: a browser
	// opens a new connection per request, so keying on the full
	// RemoteAddr would make the limiter useless.
	if code := post(h, "/api/auth/login", "10.0.0.1:2222"); code != http.StatusTooManyRequests {
		t.Fatalf("same host on a new port should share the bucket, got %d", code)
	}
	if code := post(h, "/api/auth/login", "10.0.0.9:1111"); code != http.StatusOK {
		t.Fatalf("a different host should have its own bucket, got %d", code)
	}
}

// TestRateLimit_IgnoresXForwardedFor: nothing is trusted to sit in front of
// this listener, so honouring the header would let a caller reset its own
// limit by varying it -- the limiter would be decorative.
func TestRateLimit_IgnoresXForwardedFor(t *testing.T) {
	h, _ := limitedHandler(RateLimitConfig{Burst: 1, Every: time.Minute, Paths: []string{"/api/auth/login"}})

	post(h, "/api/auth/login", "10.0.0.1:1111")
	for i := range 5 {
		req := httptest.NewRequest(http.MethodPost, "/api/auth/login", nil)
		req.RemoteAddr = "10.0.0.1:1111"
		req.Header.Set("X-Forwarded-For", fmt.Sprintf("203.0.113.%d", i))
		rec := httptest.NewRecorder()
		h.ServeHTTP(rec, req)
		if rec.Code != http.StatusTooManyRequests {
			t.Fatalf("spoofed X-Forwarded-For %d reset the limit (status %d)", i, rec.Code)
		}
	}
}

func TestRateLimit_OnlyGuardsTheNamedPaths(t *testing.T) {
	h, _ := limitedHandler(RateLimitConfig{Burst: 1, Every: time.Minute, Paths: []string{"/api/auth/login"}})

	post(h, "/api/auth/login", "10.0.0.1:1111")
	if code := post(h, "/api/auth/login", "10.0.0.1:1111"); code != http.StatusTooManyRequests {
		t.Fatalf("guarded path not limited, got %d", code)
	}
	for range 20 {
		if code := post(h, "/api/chat", "10.0.0.1:1111"); code != http.StatusOK {
			t.Fatalf("an unguarded path was throttled (status %d) -- this is a brake on credential guessing, not a traffic shaper", code)
		}
	}
}

func TestRateLimit_RefillsOverTime(t *testing.T) {
	l := &limiter{burst: 2, perSec: 1, buckets: map[string]*bucket{}}
	start := time.Unix(1_700_000_000, 0)

	if !l.allow("c", start) || !l.allow("c", start) {
		t.Fatal("the burst should have been available")
	}
	if l.allow("c", start) {
		t.Fatal("the bucket should be empty")
	}
	if !l.allow("c", start.Add(time.Second)) {
		t.Fatal("one second at 1/s should have earned one request back")
	}
	// Refill is capped at the burst: an idle client does not accumulate
	// an unlimited allowance to spend all at once.
	if !l.allow("c", start.Add(time.Hour)) || !l.allow("c", start.Add(time.Hour)) {
		t.Fatal("a long-idle client should have its full burst")
	}
	if l.allow("c", start.Add(time.Hour)) {
		t.Fatal("refill exceeded the burst ceiling")
	}
}

// TestRateLimit_SweepsIdleBuckets: the map is keyed by client address, and
// a network-facing listener sees addresses it will never see again. Without
// the sweep this grows for as long as the process runs.
func TestRateLimit_SweepsIdleBuckets(t *testing.T) {
	l := &limiter{burst: 2, perSec: 1, buckets: map[string]*bucket{}}
	start := time.Unix(1_700_000_000, 0)

	for i := range 50 {
		l.allow(fmt.Sprintf("10.0.0.%d", i), start)
	}
	if len(l.buckets) != 50 {
		t.Fatalf("buckets = %d, want 50", len(l.buckets))
	}

	// A new client arriving much later triggers the sweep; every earlier
	// bucket has long since refilled and is indistinguishable from unseen.
	l.allow("192.168.0.1", start.Add(time.Hour))
	if len(l.buckets) != 1 {
		t.Fatalf("buckets = %d after the sweep, want just the new client", len(l.buckets))
	}
}

func TestAuthRateLimit_GuardsExactlyTheUnauthenticatedAuthRoutes(t *testing.T) {
	cfg := AuthRateLimit()

	want := map[string]bool{"/api/auth/login": true, "/api/auth/register": true}
	if len(cfg.Paths) != len(want) {
		t.Fatalf("paths = %v, want exactly %v", cfg.Paths, want)
	}
	for _, p := range cfg.Paths {
		if !want[p] {
			t.Errorf("unexpected guarded path %q -- every other route is behind auth.RequireSession", p)
		}
	}
	if cfg.Burst < 5 {
		t.Errorf("burst = %d, too tight: a person mistyping a password twice must not be locked out", cfg.Burst)
	}
}

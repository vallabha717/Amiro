package middleware

import (
	"net"
	"net/http"
	"strings"
	"sync"
	"time"
)

// RateLimitConfig bounds how often one client may hit the guarded paths.
type RateLimitConfig struct {
	// Burst is how many requests a client may make back to back.
	Burst int
	// Every is how long it takes to earn one more request back.
	Every time.Duration
	// Paths are the exact request paths this limiter guards. Everything
	// else passes through untouched -- this is a targeted brake on
	// credential guessing, not a general-purpose traffic shaper.
	Paths []string
}

// AuthRateLimit is the policy applied to the unauthenticated auth routes
// when the server is bound anywhere but loopback. Ten attempts, then one
// every six seconds: far above anything a person signing in will notice,
// far below what makes online password guessing worthwhile.
func AuthRateLimit() RateLimitConfig {
	return RateLimitConfig{
		Burst: 10,
		Every: 6 * time.Second,
		Paths: []string{"/api/auth/login", "/api/auth/register"},
	}
}

// RateLimit throttles the configured paths per client IP.
//
// It exists for one situation: `amiro serve --host 0.0.0.0` puts
// POST /api/auth/login and POST /api/auth/register on a network. Both are
// unauthenticated by necessity -- a login page has to be reachable by
// someone who is not yet logged in -- and both are the classic targets. On
// loopback this is pointless (a local attacker has better options), so
// cmd/amiro only installs it for a non-loopback bind.
//
// A token bucket per IP, swept periodically. Deliberately in-process and
// memory-only: this guards a single-user desktop-shaped server, and
// reaching for a shared store here would be building for a deployment
// shape Amiro does not have.
func RateLimit(cfg RateLimitConfig) func(http.Handler) http.Handler {
	guarded := make(map[string]bool, len(cfg.Paths))
	for _, p := range cfg.Paths {
		guarded[p] = true
	}

	l := &limiter{
		burst:   float64(cfg.Burst),
		perSec:  1 / cfg.Every.Seconds(),
		buckets: make(map[string]*bucket),
	}

	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			if !guarded[r.URL.Path] || r.Method == http.MethodOptions {
				next.ServeHTTP(w, r)
				return
			}
			if !l.allow(clientIP(r), time.Now()) {
				w.Header().Set("Retry-After", "6")
				http.Error(w, "too many requests", http.StatusTooManyRequests)
				return
			}
			next.ServeHTTP(w, r)
		})
	}
}

type bucket struct {
	tokens float64
	last   time.Time
}

type limiter struct {
	burst  float64
	perSec float64

	mu      sync.Mutex
	buckets map[string]*bucket
}

func (l *limiter) allow(key string, now time.Time) bool {
	l.mu.Lock()
	defer l.mu.Unlock()

	b, ok := l.buckets[key]
	if !ok {
		// Sweep before growing the map, so a burst of one-shot source
		// addresses cannot make this grow without bound.
		l.sweepLocked(now)
		b = &bucket{tokens: l.burst, last: now}
		l.buckets[key] = b
	}

	b.tokens += now.Sub(b.last).Seconds() * l.perSec
	if b.tokens > l.burst {
		b.tokens = l.burst
	}
	b.last = now

	if b.tokens < 1 {
		return false
	}
	b.tokens--
	return true
}

// sweepLocked drops buckets that have had time to refill completely --
// they are indistinguishable from a client that has never been seen, so
// keeping them costs memory and buys nothing.
func (l *limiter) sweepLocked(now time.Time) {
	full := time.Duration(l.burst/l.perSec) * time.Second
	for k, b := range l.buckets {
		if now.Sub(b.last) > full {
			delete(l.buckets, k)
		}
	}
}

// clientIP keys the bucket by peer address only. X-Forwarded-For is
// deliberately ignored: nothing in front of this server is trusted to set
// it, and honouring a client-supplied header would let anyone reset their
// own limit by varying it.
func clientIP(r *http.Request) string {
	host, _, err := net.SplitHostPort(r.RemoteAddr)
	if err != nil {
		return strings.TrimSpace(r.RemoteAddr)
	}
	return host
}

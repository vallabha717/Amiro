package security_test

import (
	"bytes"
	"encoding/json"
	"fmt"
	"net/http"
	"testing"
	"time"

	"amiro/tests/harness"
)

// TestSecurity_AuthRateLimitAppliesOnlyBeyondLoopback is the phase
// document's "Auth rate limiting when bound beyond loopback (the Phase 0
// control)".
//
// What "the Phase 0 control" refers to: Phase 0 established that the
// backend binds loopback by default and that a non-loopback bind is the
// exceptional, guarded case. The rate limiter is the guard that hangs off
// that control. Nothing under suites/ tested it before this file --
// `grep -rn "rate" tests/suites/` found no rate-limit test on any surface,
// and backend-go's own cmd/amiro/serve_cmd_test.go only asserts that
// embeddedOptions SETS the field, at the function level, never that a
// running server enforces it.
//
// The policy, from backend-go/internal/middleware/ratelimit.go's
// AuthRateLimit(): burst 10, one token back every 6s, guarding exactly
// /api/auth/login and /api/auth/register, keyed on the peer IP with
// X-Forwarded-For deliberately ignored. It is installed by
// cmd/amiro/serve_cmd.go's embeddedOptions, and ONLY when the bind host is
// not in {127.0.0.1, ::1, localhost}.
//
// Both halves are asserted here, because the conditional is the whole
// design: the network bind must throttle, and the loopback bind must not.
// Testing only the first would pass on a server that throttled everything,
// which is a different (and worse) product.
//
// FINDING, recorded rather than asserted as a failure because it is the
// application's current shape and not this suite's to decide: cmd/server --
// the Tauri sidecar, and the binary harness/backend spawns for every other
// test in this repository -- NEVER installs the rate limiter, under any
// configuration. cmd/server/main.go passes only UI, BrowserAuth and
// LoopbackOriginWildcard to httpserver.NewWithOptions, and reacts to a
// non-loopback AMIRO_BIND_HOST with a stderr warning and nothing else. So
// `AMIRO_BIND_HOST=0.0.0.0 ./server` puts unthrottled /api/auth/login on
// the network. The subtest at the end asserts that current behaviour
// explicitly, so that if it is ever fixed this test fails and is updated
// deliberately rather than the fix landing unnoticed.
func TestSecurity_AuthRateLimitAppliesOnlyBeyondLoopback(t *testing.T) {
	h := harness.New(t, harness.NoBackend(), harness.Tags("smoke"))

	// The limiter's burst is 10 and it refills one token every 6 seconds,
	// so 15 back-to-back attempts must hit the wall and cannot refill their
	// way out of it inside the test.
	const attempts = 15

	network := startServe(t, h, "network-bind", "0.0.0.0")
	loopback := startServe(t, h, "loopback-bind", "127.0.0.1")

	// A wrong password on an account that does not exist: the request is
	// rejected either way, so what is being counted is the throttle, not
	// the outcome of a login.
	login := func(t *testing.T, s *servedBackend, n int) []int {
		t.Helper()
		var statuses []int
		for i := range n {
			body, _ := json.Marshal(map[string]string{
				"email":    fmt.Sprintf("bruteforce+%d@amiro.test", i),
				"password": "definitely-not-the-password",
			})
			req, err := http.NewRequestWithContext(t.Context(), http.MethodPost,
				s.URL+"/api/auth/login", bytes.NewReader(body))
			if err != nil {
				t.Fatal(err)
			}
			req.Header.Set("Content-Type", "application/json")
			req.Header.Set("X-Amiro-Token", s.Token)
			resp, err := (&http.Client{Timeout: 30 * time.Second}).Do(req)
			if err != nil {
				t.Fatalf("POST /api/auth/login attempt %d: %v", i+1, err)
			}
			_ = resp.Body.Close()
			statuses = append(statuses, resp.StatusCode)
			if resp.StatusCode == http.StatusTooManyRequests {
				// Record the Retry-After the middleware promises, once.
				if ra := resp.Header.Get("Retry-After"); ra != "6" {
					t.Errorf("429 carried Retry-After %q, want \"6\" (middleware.AuthRateLimit's Every)", ra)
				}
			}
		}
		return statuses
	}

	t.Run("a_network_bind_throttles_repeated_logins", func(t *testing.T) {
		statuses := login(t, network, attempts)
		t.Logf("statuses on --host 0.0.0.0: %v", statuses)

		firstThrottled := -1
		for i, s := range statuses {
			if s == http.StatusTooManyRequests {
				firstThrottled = i
				break
			}
		}
		if firstThrottled < 0 {
			t.Fatalf("%d back-to-back logins against `amiro serve --host 0.0.0.0` produced no 429; "+
				"middleware.AuthRateLimit (burst 10) is not installed on a network bind: %v", attempts, statuses)
		}
		// Burst is 10, so nothing before the 11th attempt should be
		// throttled. A limiter that fired earlier would be a usability bug
		// as real as the absence of one is a security bug.
		if firstThrottled < 10 {
			t.Errorf("the first 429 came at attempt %d, before the configured burst of 10 was spent: %v",
				firstThrottled+1, statuses)
		}
	})

	t.Run("a_loopback_bind_does_not_throttle", func(t *testing.T) {
		statuses := login(t, loopback, attempts)
		t.Logf("statuses on --host 127.0.0.1: %v", statuses)
		for i, s := range statuses {
			if s == http.StatusTooManyRequests {
				t.Fatalf("attempt %d against `amiro serve --host 127.0.0.1` was throttled (%v). "+
					"cmd/amiro/serve_cmd.go installs the limiter only for a non-loopback bind, so this "+
					"means either the condition changed or the sibling subtest's 429 proves nothing about it.",
					i+1, statuses)
			}
		}
	})

	// The recorded gap, asserted so it cannot change silently. See this
	// test's doc comment.
	t.Run("finding_the_sidecar_binary_never_installs_the_limiter", func(t *testing.T) {
		sidecar := harness.New(t, harness.Tags("smoke"))
		be := sidecar.Backend()

		var statuses []int
		for i := range attempts {
			body, _ := json.Marshal(map[string]string{
				"email":    fmt.Sprintf("bruteforce+sidecar+%d@amiro.test", i),
				"password": "definitely-not-the-password",
			})
			req, err := http.NewRequestWithContext(t.Context(), http.MethodPost,
				be.URL+"/api/auth/login", bytes.NewReader(body))
			if err != nil {
				t.Fatal(err)
			}
			req.Header.Set("Content-Type", "application/json")
			be.Authorize(req)
			resp, err := (&http.Client{Timeout: 30 * time.Second}).Do(req)
			if err != nil {
				t.Fatalf("POST /api/auth/login attempt %d: %v", i+1, err)
			}
			_ = resp.Body.Close()
			statuses = append(statuses, resp.StatusCode)
		}
		t.Logf("statuses against cmd/server (the sidecar): %v", statuses)
		for _, s := range statuses {
			if s == http.StatusTooManyRequests {
				t.Fatalf("cmd/server throttled a login. That is an IMPROVEMENT over the behaviour this "+
					"test recorded -- cmd/server/main.go passed no RateLimit to httpserver.NewWithOptions "+
					"when this was written. Update this subtest to assert the new, better behaviour: %v",
					statuses)
			}
		}
		t.Logf("FINDING (recorded, not a failure): cmd/server installs no auth rate limiter. " +
			"AMIRO_BIND_HOST=0.0.0.0 on the sidecar therefore exposes unthrottled POST /api/auth/login. " +
			"Closing step: have cmd/server/main.go mirror cmd/amiro/serve_cmd.go's embeddedOptions and " +
			"set httpserver.Options.RateLimit when cfg.BindHost is not loopback.")
	})
}

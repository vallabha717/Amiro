package client

import (
	"context"
	"testing"
)

// TestConnect_AttachesWithTheRightToken is the Phase 5 TUI gate: "attach-mode
// client test against httptest." A real httptest.Server (the same testServer
// helper Phase 1-4 built up), a client built with nothing but the URL and the
// server's shared secret -- no lock file, no Discover, no StartEmbedded --
// must be able to reach it exactly like an attached desktop sidecar would.
func TestConnect_AttachesWithTheRightToken(t *testing.T) {
	baseURL, authToken := testServer(t, fakeEngine{deltas: []string{"hi"}})

	c, err := Connect(context.Background(), baseURL, authToken)
	if err != nil {
		t.Fatalf("Connect: %v", err)
	}
	if !c.Health(context.Background()) {
		t.Fatalf("connected client fails its own health check")
	}

	sessionToken := registerAndLogin(t, baseURL, authToken)
	authed := c.WithSessionToken(sessionToken)
	frames, wait := authed.SendMessage(context.Background(), SendMessageRequest{
		ThreadID: "thread-1", MessageID: "msg-1", Text: "hello",
	})
	for range frames {
	}
	if err := wait(); err != nil {
		t.Fatalf("wait() = %v, want nil -- a --connect'd client should stream a turn exactly like an attached one", err)
	}
}

// TestConnect_RejectsAMissingToken is the safety rule from resolveSession's
// doc comment, checked at the one place that can enforce it before any
// request is even attempted: an explicitly-attached server is a stranger's
// process, so Connect must not try to reach it with no token and let a
// generic 401 stand in for "you forgot --token."
func TestConnect_RejectsAMissingToken(t *testing.T) {
	baseURL, _ := testServer(t, fakeEngine{})

	if _, err := Connect(context.Background(), baseURL, ""); err == nil {
		t.Fatalf("Connect with no token = nil error, want a clean failure")
	}
}

// TestConnect_RejectsAWrongToken proves a wrong token fails at the health
// check -- Connect never assumes a server is reachable just because a URL
// was supplied, the same "prove liveness with a real round trip" rule
// Discover already follows for its lock file.
func TestConnect_RejectsAWrongToken(t *testing.T) {
	baseURL, _ := testServer(t, fakeEngine{})

	if _, err := Connect(context.Background(), baseURL, "not-the-real-token"); err == nil {
		t.Fatalf("Connect with a wrong token = nil error, want a clean failure")
	}
}

// TestConnect_RejectsAnUnreachableURL covers the "another machine entirely"
// half of Appendix A's --connect: nothing answering at all, not just a bad
// token.
func TestConnect_RejectsAnUnreachableURL(t *testing.T) {
	if _, err := Connect(context.Background(), "http://127.0.0.1:1", "any-token"); err == nil {
		t.Fatalf("Connect to an unreachable URL = nil error, want a clean failure")
	}
}

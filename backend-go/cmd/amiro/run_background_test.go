package main

import (
	"context"
	"testing"
)

func TestArgsRequestBackground(t *testing.T) {
	cases := []struct {
		args []string
		want bool
	}{
		{[]string{"do a thing", "--background"}, true},
		{[]string{"do a thing", "-background"}, true},
		{[]string{"do a thing", "--background=true"}, true},
		{[]string{"do a thing", "--json"}, false},
		{[]string{"do a thing"}, false},
		{nil, false},
	}
	for _, c := range cases {
		if got := argsRequestBackground(c.args); got != c.want {
			t.Errorf("argsRequestBackground(%v) = %v, want %v", c.args, got, c.want)
		}
	}
}

// TestRunHeadlessBackgroundTurn_RequiresAPrompt and
// TestRunHeadlessBackgroundTurn_RejectsPlanAndInteractiveModes cover the
// validation runHeadlessBackgroundTurn does before it ever touches config
// or a transport -- the same "fails fast, before any network or backend
// call" property runHeadlessTurn's own flag validation has, and the only
// part of this function a test can exercise without a running server.
func TestRunHeadlessBackgroundTurn_RequiresAPrompt(t *testing.T) {
	_, _, err := runHeadlessBackgroundTurn(context.Background(), []string{"--background"})
	if err == nil {
		t.Fatal("want an error for a missing prompt")
	}
}

func TestRunHeadlessBackgroundTurn_RejectsPlanAndInteractiveModes(t *testing.T) {
	for _, mode := range []string{"plan", "interactive", "manual", "bogus"} {
		_, _, err := runHeadlessBackgroundTurn(context.Background(), []string{"do a thing", "--background", "--mode", mode})
		if err == nil {
			t.Fatalf("mode %q: want an error -- a background job may only be edit or auto", mode)
		}
	}
}

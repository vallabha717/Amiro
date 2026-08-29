package sandbox

import "testing"

// TestNetworkAllowed_MatchesSameShapeAsCommandAllowlist pins
// NetworkAllowed's matching contract: prefix on parsed tokens, same as
// permission.commandAllowed. These cases mirror that package's own test
// table intentionally.
func TestNetworkAllowed_MatchesSameShapeAsCommandAllowlist(t *testing.T) {
	allow := []string{"go build", "npm install", "npm ci"}

	cases := []struct {
		command string
		want    bool
	}{
		{"go build ./...", true},
		{"go build", true},
		{"go buildsomething", false}, // different token, not a prefix match
		{"go", false},                // shorter than the entry
		{"npm install lodash", true},
		{"npm ci", true},
		{"npm run build", false},
		{"rm -rf /", false},
		{"", false},
		{"go build && rm -rf /", false}, // shell operator disqualifies it
	}
	for _, c := range cases {
		if got := NetworkAllowed(allow, c.command); got != c.want {
			t.Errorf("NetworkAllowed(%v, %q) = %v, want %v", allow, c.command, got, c.want)
		}
	}
}

// TestNetworkAllowed_EmptyAllowlistDeniesEverything is the safe-default
// case: an empty (nil) SandboxNetworkAllow means nothing gets network,
// which is the whole point of an opt-in list.
func TestNetworkAllowed_EmptyAllowlistDeniesEverything(t *testing.T) {
	if NetworkAllowed(nil, "go build") {
		t.Fatal("NetworkAllowed(nil, ...) = true, want false -- an empty allow-list must deny by default")
	}
	if NetworkAllowed([]string{}, "echo hi") {
		t.Fatal("NetworkAllowed([]string{}, ...) = true, want false")
	}
}

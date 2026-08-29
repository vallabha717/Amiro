package sandbox

import "strings"

// shellOperatorTokens mirrors
// internal/agent/permission/command.go's shellOperators exactly: anything
// carrying one of these turns "one command" into "possibly several," and
// must not be matched against an allow-list built for the first command
// alone.
var shellOperatorTokens = []string{";", "&", "|", ">", "<", "`", "$(", "(", "\n", "\r"}

func hasShellOperators(command string) bool {
	for _, op := range shellOperatorTokens {
		if strings.Contains(command, op) {
			return true
		}
	}
	return false
}

// NetworkAllowed reports whether command's prefix matches an entry in
// allowlist -- internal/config's SandboxNetworkAllow, a per-project,
// deliberate opt-in for commands that legitimately need network (`go
// build` fetching a module, `npm install` reaching a registry).
//
// Matching mirrors internal/agent/permission/command.go's commandAllowed
// exactly: parsed tokens, not a raw substring, so an allow-list entry of
// "go build" matches `go build ./...` but never `go buildsomething` (a
// different token) or a bare `go` (shorter than the entry). The two
// matchers are intentionally not shared code -- they answer different
// questions (may this run at all vs. may this reach the network) governed
// by two different lists a user configures independently -- but they must
// stay behaviorally identical, which is what
// TestNetworkAllowed_MatchesSameShapeAsCommandAllowlist pins down.
func NetworkAllowed(allowlist []string, command string) bool {
	if hasShellOperators(command) {
		// A compound command ("go build && curl evil.example") must not
		// inherit "go build"'s network allowance for its second half --
		// exactly the same reasoning permission.commandAllowed disqualifies
		// shell-operator commands from auto-allowlisting at all.
		return false
	}
	argv, ok := splitCommandWords(command)
	if !ok || len(argv) == 0 {
		return false
	}
	for _, entry := range allowlist {
		prefix, ok := splitCommandWords(entry)
		if !ok || len(prefix) == 0 || len(prefix) > len(argv) {
			continue
		}
		matched := true
		for i, tok := range prefix {
			if argv[i] != tok {
				matched = false
				break
			}
		}
		if matched {
			return true
		}
	}
	return false
}

// splitCommandWords is a minimal POSIX-ish word splitter, identical in
// behavior to permission.splitArgs (unexported there, so this is a
// deliberate, small duplication rather than a package-cycle-inducing
// import -- internal/agent/permission already imports internal/ai/tools,
// and internal/ai/tools/terminal.go is this package's caller).
func splitCommandWords(s string) ([]string, bool) {
	var (
		out   []string
		cur   strings.Builder
		inTok bool
		quote rune
	)
	runes := []rune(s)
	for i := 0; i < len(runes); i++ {
		r := runes[i]
		switch {
		case r == '\\' && quote != '\'':
			if i+1 >= len(runes) {
				return nil, false
			}
			i++
			cur.WriteRune(runes[i])
			inTok = true
		case quote != 0:
			if r == quote {
				quote = 0
			} else {
				cur.WriteRune(r)
			}
		case r == '\'' || r == '"':
			quote = r
			inTok = true
		case r == ' ' || r == '\t':
			if inTok {
				out = append(out, cur.String())
				cur.Reset()
				inTok = false
			}
		default:
			cur.WriteRune(r)
			inTok = true
		}
	}
	if quote != 0 {
		return nil, false
	}
	if inTok {
		out = append(out, cur.String())
	}
	return out, true
}

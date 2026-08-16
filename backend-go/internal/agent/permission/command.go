package permission

import "strings"

// shellOperators are the characters that turn one command into several.
//
// The allowlist auto-runs a command *without* showing it to anyone, so
// prefix matching on the raw string is unsafe: an entry of "git status"
// would auto-approve `git status && rm -rf ~`. Anything carrying one of
// these is disqualified from the allowlist outright and goes to the user
// instead, where they read the literal command before it runs.
//
// Chaining (`;` `&` `&&` `||`), pipes (`|`), redirection (`>` `<`),
// command substitution (“ ` “ `$(`), grouping (`(`), and newlines --
// which are the plainest chaining operator of all and the easiest to
// forget.
var shellOperators = []string{";", "&", "|", ">", "<", "`", "$(", "(", "\n", "\r"}

// HasShellOperators reports whether a command line contains anything that
// could make it run more than the one thing it appears to run.
//
// Exported because the approval card wants to say so: a command that is
// only asking because it is compound reads very differently from one asking
// because it is simply not on the list.
func HasShellOperators(command string) bool {
	for _, op := range shellOperators {
		if strings.Contains(command, op) {
			return true
		}
	}
	return false
}

// DefaultAllowedCommands is the built-in allowlist: commands that run
// without asking in Interactive mode.
//
// Deliberately tiny, and deliberately all-reads. The temptation is to add
// `go build`, `go test`, `npm run` -- the things an agent runs constantly
// -- but every one of those executes project code (generators, test
// bodies, lifecycle scripts), which is indistinguishable from running an
// arbitrary program. A user who wants that can add it; the default must not
// decide it for them.
var DefaultAllowedCommands = []string{
	"git status",
	"git diff",
	"git log",
	"git show",
	"ls",
	"pwd",
	"cat",
	"head",
	"tail",
	"wc",
	"file",
	"which",
	"echo",
}

// commandAllowed reports whether a command line matches the allowlist.
//
// Matching is on parsed tokens, not the raw string: an entry's tokens must
// be an exact prefix of the command's tokens. So "git status" matches
// `git status -s` but never `git statusfoo` (different token) and never a
// bare `git` (shorter than the entry).
func (e *Engine) commandAllowed(command string) bool {
	if HasShellOperators(command) {
		return false
	}
	argv, ok := splitArgs(command)
	if !ok || len(argv) == 0 {
		return false
	}
	for _, entry := range e.allowedCommands {
		prefix, ok := splitArgs(entry)
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

// splitArgs is a minimal POSIX-ish word splitter: whitespace separates
// tokens, single and double quotes group, backslash escapes the next
// character. It returns false on an unterminated quote.
//
// This is not a shell parser and must not become one. It exists so
// allowlist matching compares words rather than substrings; anything with
// real shell syntax in it was already rejected by HasShellOperators before
// reaching here, and an input this cannot parse is treated as
// not-allowlisted -- the safe direction.
func splitArgs(s string) ([]string, bool) {
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
			// A trailing backslash is a line continuation in a real shell,
			// which is not something an allowlisted command should contain.
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

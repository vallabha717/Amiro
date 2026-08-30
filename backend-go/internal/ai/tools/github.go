package tools

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"regexp"
	"strings"
	"time"

	"amiro/backend/internal/agent/workspace"
)

// githubTimeout bounds the one HTTP call create_pr makes. Generous enough
// for a slow API response, short enough that a hung connection cannot hold
// a turn open indefinitely.
const githubTimeout = 30 * time.Second

// defaultGitHubAPIBase is the real GitHub REST API root. Overridden only by
// tests -- see internal/config.Config.GitHubAPIBase's doc comment.
const defaultGitHubAPIBase = "https://api.github.com"

// githubRemoteRE matches the three shapes `git remote get-url origin`
// actually returns for a GitHub repo: the SSH shorthand, the ssh:// form,
// and https. Anything else (a non-GitHub host, a local path) does not
// match, which is exactly "this phase is GitHub-only" --
// docs/coding-agent-parity/04-git-remote-operations.md.
var githubRemoteRE = regexp.MustCompile(`^(?:https?://github\.com/|git@github\.com:|ssh://git@github\.com/)([^/]+)/([^/]+?)(?:\.git)?/?$`)

// parseGitHubRemote extracts owner/repo from a GitHub remote URL.
func parseGitHubRemote(url string) (owner, repo string, err error) {
	m := githubRemoteRE.FindStringSubmatch(strings.TrimSpace(url))
	if m == nil {
		return "", "", fmt.Errorf("create_pr: the %q remote (%q) is not a github.com URL -- "+
			"only GitHub is supported so far", gitPushRemote, url)
	}
	return m[1], m[2], nil
}

type createPRInput struct {
	// Base is the branch to open the PR against (e.g. "main"). The model
	// supplies this -- unlike push's branch, picking a target branch is a
	// low-stakes choice with no destructive failure mode, so there is
	// nothing here worth resolving automatically instead.
	Base string `json:"base"`
	// Draft opens the PR as a draft. Optional, defaults false.
	Draft bool `json:"draft,omitempty"`
}

// CreatePROutput is what the presenter renders and the model sees back.
type CreatePROutput struct {
	Owner  string `json:"owner"`
	Repo   string `json:"repo"`
	Head   string `json:"head"`
	Base   string `json:"base"`
	Title  string `json:"title"`
	Body   string `json:"body"`
	Draft  bool   `json:"draft,omitempty"`
	URL    string `json:"url,omitempty"`
	Number int    `json:"number,omitempty"`
	Error  string `json:"error,omitempty"`
}

// prTitle truncates a walkthrough summary to a PR-title-shaped single line.
func prTitle(summary string) string {
	line := strings.TrimSpace(strings.SplitN(summary, "\n", 2)[0])
	const max = 72
	r := []rune(line)
	if len(r) > max {
		return string(r[:max-1]) + "…"
	}
	return line
}

// prBody renders the full walkthrough as PR description markdown -- the
// "what changed, in reading order" text docs/coding-agent-parity/
// 04-git-remote-operations.md says this phase reuses rather than asking
// the model to write a second summary.
func prBody(w Walkthrough) string {
	var b strings.Builder
	b.WriteString(w.Summary)
	if len(w.Changes) > 0 {
		b.WriteString("\n\n## Changes\n")
		for _, c := range w.Changes {
			if c.Why != "" {
				fmt.Fprintf(&b, "- `%s` -- %s\n", c.Path, c.Why)
			} else {
				fmt.Fprintf(&b, "- `%s`\n", c.Path)
			}
		}
	}
	if w.Testing != "" {
		fmt.Fprintf(&b, "\n## Testing\n%s\n", w.Testing)
	}
	if len(w.FollowUps) > 0 {
		b.WriteString("\n## Follow-ups\n")
		for _, f := range w.FollowUps {
			fmt.Fprintf(&b, "- %s\n", f)
		}
	}
	return b.String()
}

// createPRTool opens a GitHub pull request from the current branch.
//
// tokenFn and apiBase come from Deps rather than being read from
// internal/secrets or internal/config directly, for the same "leaf package,
// caller supplies its backends" reasoning every other stateful tool in this
// file follows -- see tools.go's Deps doc comment.
func createPRTool(ws *workspace.Workspace, rec *WalkthroughRecord, tokenFn func(context.Context) (string, bool, error), apiBase string) Definition {
	if apiBase == "" {
		apiBase = defaultGitHubAPIBase
	}
	return Definition{
		Name:    NameCreatePR,
		Toolkit: ToolkitFile,
		Risk:    RiskExternal,
		// Always asks, the same as git push and for the same reason: this
		// writes to a system outside the user's own machine. See
		// docs/coding-agent-parity/04-git-remote-operations.md.
		AlwaysAsk:   func(json.RawMessage) bool { return true },
		Description: "Open a GitHub pull request from the current branch. Call walkthrough first in this turn -- the PR title and body are built from its output, not written here. head is always the current branch; base is the branch to merge into (e.g. \"main\"). Requires a GitHub token to be connected in Settings, and an \"origin\" remote pointing at a github.com repo.",
		ParametersSchema: json.RawMessage(`{
			"type": "object",
			"properties": {
				"base": {"type": "string", "description": "The branch to open the PR against, e.g. \"main\"."},
				"draft": {"type": "boolean", "description": "Open as a draft PR. Defaults to false."}
			},
			"required": ["base"],
			"additionalProperties": false
		}`),
		Execute: func(ctx context.Context, raw json.RawMessage) (any, error) {
			var in createPRInput
			if err := json.Unmarshal(raw, &in); err != nil {
				return nil, fmt.Errorf("create_pr: %w", err)
			}
			in.Base = strings.TrimSpace(in.Base)
			if in.Base == "" {
				return nil, fmt.Errorf("create_pr: base is required -- which branch should this merge into?")
			}

			if tokenFn == nil {
				return nil, fmt.Errorf("create_pr: no GitHub token is configured -- connect one in Settings (Connect GitHub) before opening a pull request")
			}
			token, ok, err := tokenFn(ctx)
			if err != nil {
				return nil, fmt.Errorf("create_pr: reading the stored GitHub token: %w", err)
			}
			if !ok || strings.TrimSpace(token) == "" {
				return nil, fmt.Errorf("create_pr: no GitHub token is configured -- connect one in Settings (Connect GitHub) before opening a pull request")
			}

			remoteURL, err := gitRemoteURL(ctx, ws, gitPushRemote)
			if err != nil {
				return nil, err
			}
			owner, repo, err := parseGitHubRemote(remoteURL)
			if err != nil {
				return nil, err
			}

			head, err := currentBranch(ctx, ws)
			if err != nil {
				return nil, err
			}

			walkthrough, ok := rec.Get()
			if !ok {
				return nil, fmt.Errorf("create_pr: call walkthrough first in this turn -- the PR description is built from it, not written separately")
			}

			out := CreatePROutput{
				Owner: owner, Repo: repo, Head: head, Base: in.Base,
				Title: prTitle(walkthrough.Summary), Body: prBody(walkthrough), Draft: in.Draft,
			}

			reqBody, _ := json.Marshal(map[string]any{
				"title": out.Title, "body": out.Body, "head": out.Head, "base": out.Base, "draft": out.Draft,
			})

			execCtx, cancel := context.WithTimeout(ctx, githubTimeout)
			defer cancel()
			url := fmt.Sprintf("%s/repos/%s/%s/pulls", strings.TrimRight(apiBase, "/"), owner, repo)
			httpReq, err := http.NewRequestWithContext(execCtx, http.MethodPost, url, bytes.NewReader(reqBody))
			if err != nil {
				return nil, fmt.Errorf("create_pr: %w", err)
			}
			httpReq.Header.Set("Authorization", "Bearer "+token)
			httpReq.Header.Set("Accept", "application/vnd.github+json")
			httpReq.Header.Set("Content-Type", "application/json")
			httpReq.Header.Set("X-GitHub-Api-Version", "2022-11-28")
			httpReq.Header.Set("User-Agent", "amiro-agent")

			resp, err := http.DefaultClient.Do(httpReq)
			if err != nil {
				// Surfaced in the result, not returned as a Go error: the
				// call was attempted (unlike the refusals above), and a
				// model that sees the failure can decide what to do next --
				// docs/coding-agent-parity/04-git-remote-operations.md's
				// "no retry loop hidden inside the tool".
				out.Error = err.Error()
				return out, nil
			}
			defer resp.Body.Close()
			respBody, _ := io.ReadAll(io.LimitReader(resp.Body, 1<<20))

			if resp.StatusCode != http.StatusCreated {
				out.Error = fmt.Sprintf("GitHub API returned %s: %s", resp.Status, strings.TrimSpace(string(respBody)))
				return out, nil
			}

			var created struct {
				HTMLURL string `json:"html_url"`
				Number  int    `json:"number"`
			}
			if err := json.Unmarshal(respBody, &created); err == nil {
				out.URL = created.HTMLURL
				out.Number = created.Number
			}
			return out, nil
		},
	}
}

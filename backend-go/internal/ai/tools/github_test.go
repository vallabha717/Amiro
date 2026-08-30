package tools

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"amiro/backend/internal/agent/workspace"
)

// githubFixture is a real git repo with an "origin" remote shaped like a
// real GitHub URL (parseGitHubRemote needs github.com in it), on a named
// branch with a commit -- create_pr never touches the network itself
// except the one call to the fake server this fixture's caller points it
// at via apiBase.
func githubFixture(t *testing.T, branch string) *workspace.Workspace {
	t.Helper()
	root := t.TempDir()
	runGitFor(t, root, "init", "-q")
	runGitFor(t, root, "checkout", "-q", "-b", branch)
	runGitFor(t, root, "commit", "-q", "--allow-empty", "-m", "initial")
	runGitFor(t, root, "remote", "add", "origin", "https://github.com/acme/widgets.git")
	ws, err := workspace.New(root)
	if err != nil {
		t.Fatalf("workspace.New: %v", err)
	}
	return ws
}

func fixedToken(token string) func(context.Context) (string, bool, error) {
	return func(context.Context) (string, bool, error) { return token, true, nil }
}

func noToken() func(context.Context) (string, bool, error) {
	return func(context.Context) (string, bool, error) { return "", false, nil }
}

// TestCreatePR_BuildsDescriptionFromWalkthrough is exit criterion 3,
// literally: the PR's title and body come from a walkthrough call earlier
// in the same turn, against a fake GitHub API -- no live network.
func TestCreatePR_BuildsDescriptionFromWalkthrough(t *testing.T) {
	ws := githubFixture(t, "feature-pr")
	rec := NewWalkthroughRecord()
	rec.Set(Walkthrough{
		Summary: "Add the widget exporter",
		Changes: []WalkthroughChange{
			{Path: "exporter.go", Why: "the new exporter itself"},
			{Path: "exporter_test.go", Why: "covers it"},
		},
		Testing: "go test ./...",
	})

	var gotReq struct {
		Title string `json:"title"`
		Body  string `json:"body"`
		Head  string `json:"head"`
		Base  string `json:"base"`
		Draft bool   `json:"draft"`
	}
	var gotPath, gotAuth string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotPath = r.URL.Path
		gotAuth = r.Header.Get("Authorization")
		_ = json.NewDecoder(r.Body).Decode(&gotReq)
		w.WriteHeader(http.StatusCreated)
		_ = json.NewEncoder(w).Encode(map[string]any{"html_url": "https://github.com/acme/widgets/pull/7", "number": 7})
	}))
	defer srv.Close()

	d := createPRTool(ws, rec, fixedToken("gh-secret-token"), srv.URL)
	out, err := d.Execute(context.Background(), json.RawMessage(`{"base":"main"}`))
	if err != nil {
		t.Fatalf("Execute: %v", err)
	}
	result := out.(CreatePROutput)

	if gotPath != "/repos/acme/widgets/pulls" {
		t.Errorf("POST path = %q, want /repos/acme/widgets/pulls", gotPath)
	}
	if gotAuth != "Bearer gh-secret-token" {
		t.Errorf("Authorization = %q, want Bearer gh-secret-token", gotAuth)
	}
	if gotReq.Head != "feature-pr" {
		t.Errorf("head = %q, want the checked-out branch feature-pr", gotReq.Head)
	}
	if gotReq.Base != "main" {
		t.Errorf("base = %q, want main", gotReq.Base)
	}
	if gotReq.Title != "Add the widget exporter" {
		t.Errorf("title = %q, want the walkthrough summary", gotReq.Title)
	}
	if !strings.Contains(gotReq.Body, "exporter.go") || !strings.Contains(gotReq.Body, "the new exporter itself") {
		t.Errorf("body = %q, want it to include the walkthrough's changes", gotReq.Body)
	}
	if !strings.Contains(gotReq.Body, "go test ./...") {
		t.Errorf("body = %q, want it to include the walkthrough's testing note", gotReq.Body)
	}
	if result.URL != "https://github.com/acme/widgets/pull/7" || result.Number != 7 {
		t.Errorf("result = %+v, want the fake server's URL/number reflected back", result)
	}
	if result.Error != "" {
		t.Errorf("Error = %q, want empty on success", result.Error)
	}
}

// TestCreatePR_RefusesWithoutWalkthroughFirst enforces "sourced from the
// turn's own walkthrough output" structurally: no walkthrough this turn,
// no PR, rather than inventing a description.
func TestCreatePR_RefusesWithoutWalkthroughFirst(t *testing.T) {
	ws := githubFixture(t, "feature-no-walkthrough")
	rec := NewWalkthroughRecord() // never Set

	var called bool
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		called = true
		w.WriteHeader(http.StatusCreated)
	}))
	defer srv.Close()

	d := createPRTool(ws, rec, fixedToken("gh-secret-token"), srv.URL)
	_, err := d.Execute(context.Background(), json.RawMessage(`{"base":"main"}`))
	if err == nil {
		t.Fatal("expected an error with no walkthrough recorded")
	}
	if !strings.Contains(err.Error(), "walkthrough") {
		t.Errorf("error = %q, want it to mention walkthrough", err.Error())
	}
	if called {
		t.Fatal("the fake GitHub API was called despite no walkthrough being recorded -- must refuse before any HTTP call")
	}
}

// TestCreatePR_RefusesWithNoToken is the other named failure mode: no
// token, no HTTP call, a message naming Settings.
func TestCreatePR_RefusesWithNoToken(t *testing.T) {
	ws := githubFixture(t, "feature-no-token")
	rec := NewWalkthroughRecord()
	rec.Set(Walkthrough{Summary: "did a thing", Changes: []WalkthroughChange{{Path: "a.go", Why: "why"}}})

	var called bool
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		called = true
		w.WriteHeader(http.StatusCreated)
	}))
	defer srv.Close()

	d := createPRTool(ws, rec, noToken(), srv.URL)
	_, err := d.Execute(context.Background(), json.RawMessage(`{"base":"main"}`))
	if err == nil {
		t.Fatal("expected an error with no GitHub token configured")
	}
	if !strings.Contains(err.Error(), "Settings") {
		t.Errorf("error = %q, want it to name Settings", err.Error())
	}
	if called {
		t.Fatal("the fake GitHub API was called despite no token being configured")
	}

	// Also true for a nil tokenFn (no GitHub wiring at all -- most non-web
	// entrypoints, e.g. the eval agent).
	d2 := createPRTool(ws, rec, nil, srv.URL)
	if _, err := d2.Execute(context.Background(), json.RawMessage(`{"base":"main"}`)); err == nil {
		t.Fatal("expected an error with a nil GitHubToken func")
	}
}

// TestCreatePR_RefusesNonGitHubRemote: this phase is GitHub-only, and it
// says so rather than guessing at a GitLab/Bitbucket shape.
func TestCreatePR_RefusesNonGitHubRemote(t *testing.T) {
	root := t.TempDir()
	runGitFor(t, root, "init", "-q")
	runGitFor(t, root, "checkout", "-q", "-b", "feature-x")
	runGitFor(t, root, "commit", "-q", "--allow-empty", "-m", "initial")
	runGitFor(t, root, "remote", "add", "origin", "https://gitlab.com/acme/widgets.git")
	ws, err := workspace.New(root)
	if err != nil {
		t.Fatalf("workspace.New: %v", err)
	}

	rec := NewWalkthroughRecord()
	rec.Set(Walkthrough{Summary: "s", Changes: []WalkthroughChange{{Path: "a.go", Why: "w"}}})
	d := createPRTool(ws, rec, fixedToken("t"), "http://unused.invalid")
	_, err = d.Execute(context.Background(), json.RawMessage(`{"base":"main"}`))
	if err == nil {
		t.Fatal("expected an error for a non-github.com remote")
	}
	if !strings.Contains(err.Error(), "github") {
		t.Errorf("error = %q, want it to mention GitHub-only scope", err.Error())
	}
}

// TestCreatePR_SurfacesGitHubAPIErrorVerbatim: a rejection from GitHub
// (rate limit, validation error) is surfaced in the result, not hidden or
// retried -- docs/coding-agent-parity/04-git-remote-operations.md.
func TestCreatePR_SurfacesGitHubAPIErrorVerbatim(t *testing.T) {
	ws := githubFixture(t, "feature-api-error")
	rec := NewWalkthroughRecord()
	rec.Set(Walkthrough{Summary: "s", Changes: []WalkthroughChange{{Path: "a.go", Why: "w"}}})

	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusUnprocessableEntity)
		_, _ = w.Write([]byte(`{"message":"A pull request already exists for acme:feature-api-error."}`))
	}))
	defer srv.Close()

	d := createPRTool(ws, rec, fixedToken("t"), srv.URL)
	out, err := d.Execute(context.Background(), json.RawMessage(`{"base":"main"}`))
	if err != nil {
		t.Fatalf("Execute returned a Go error, want the failure surfaced in the result: %v", err)
	}
	result := out.(CreatePROutput)
	if !strings.Contains(result.Error, "already exists") {
		t.Errorf("Error = %q, want the GitHub API's message surfaced verbatim", result.Error)
	}
}

// TestCreatePR_RequiresBase: base is the one required model input, since
// head is always resolved for the model.
func TestCreatePR_RequiresBase(t *testing.T) {
	ws := githubFixture(t, "feature-no-base")
	rec := NewWalkthroughRecord()
	rec.Set(Walkthrough{Summary: "s", Changes: []WalkthroughChange{{Path: "a.go", Why: "w"}}})
	d := createPRTool(ws, rec, fixedToken("t"), "http://unused.invalid")
	if _, err := d.Execute(context.Background(), json.RawMessage(`{}`)); err == nil {
		t.Fatal("expected an error with no base branch given")
	}
}

// TestCreatePRDefinition_AlwaysAsksUnconditionally matches git push's
// contract: create_pr always asks, regardless of input.
func TestCreatePRDefinition_AlwaysAsksUnconditionally(t *testing.T) {
	ws := githubFixture(t, "feature-always-ask")
	d := createPRTool(ws, NewWalkthroughRecord(), fixedToken("t"), "http://unused.invalid")
	if d.AlwaysAsk == nil {
		t.Fatal("create_pr Definition.AlwaysAsk is nil")
	}
	if !d.AlwaysAsk(json.RawMessage(`{"base":"main"}`)) {
		t.Error("AlwaysAsk(...) = false, want true unconditionally")
	}
	if d.Risk != RiskExternal {
		t.Errorf("Risk = %v, want RiskExternal", d.Risk)
	}
}

func TestParseGitHubRemote(t *testing.T) {
	for _, tc := range []struct {
		url, owner, repo string
		wantErr          bool
	}{
		{"https://github.com/acme/widgets.git", "acme", "widgets", false},
		{"https://github.com/acme/widgets", "acme", "widgets", false},
		{"git@github.com:acme/widgets.git", "acme", "widgets", false},
		{"ssh://git@github.com/acme/widgets.git", "acme", "widgets", false},
		{"https://gitlab.com/acme/widgets.git", "", "", true},
		{"/some/local/path", "", "", true},
	} {
		owner, repo, err := parseGitHubRemote(tc.url)
		if tc.wantErr {
			if err == nil {
				t.Errorf("parseGitHubRemote(%q): expected an error", tc.url)
			}
			continue
		}
		if err != nil {
			t.Errorf("parseGitHubRemote(%q): %v", tc.url, err)
			continue
		}
		if owner != tc.owner || repo != tc.repo {
			t.Errorf("parseGitHubRemote(%q) = (%q, %q), want (%q, %q)", tc.url, owner, repo, tc.owner, tc.repo)
		}
	}
}

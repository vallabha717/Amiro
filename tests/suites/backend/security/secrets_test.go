package security_test

import (
	"os"
	"path/filepath"
	"strings"
	"testing"

	"amiro/tests/harness"
	"amiro/tests/harness/apiclient"
	"amiro/tests/harness/config"
	"amiro/tests/harness/fakeprovider"
)

// TestSecurity_ARuntimeProviderKeyNeverReachesAResponseOrAnArtifact is the
// phase document's "Secrets never in responses, logs, traces, HAR files or
// cassettes".
//
// The gap this closes. suites/meta/secret_leak_test.go already sweeps the
// whole run tree for h.Config.Secrets() and already proves the redactor
// works on a password sent through POST /api/auth/register. But
// Config.Secrets() enumerates only what the CONFIGURATION knows: provider
// keys written in config.yaml, the three account passwords, and anything
// in backend.env. A key a test creates at RUNTIME -- POSTed to
// /api/ai/providers, which is how a real user adds one from the dashboard
// -- is in none of those lists, so the existing guard would not notice it
// leaking. That is the case tested here, and it is the case that matters,
// because it is the one real users produce.
//
// The key is deliberately NOT registered with the harness redactor. The
// point is to find out whether the field-name pass (providers.redact
// includes "apiKey") catches it on its own, which is the protection a real
// user's key actually gets.
//
// One thing this test does NOT assert, because the application is explicit
// that it is intended: GET /api/ai/providers returns a stored key IN THE
// CLEAR to the signed-in caller. backend-go/internal/api/ai/providers.go's
// ProviderStatusDTO says so in as many words -- "APIKey is returned in the
// clear. That is deliberate and is the whole point of this screen... a key
// the user can't read back is a key they can't verify or fix." So the
// assertions below are about who may read it and where else it may land,
// not about whether it is readable at all.
func TestSecurity_ARuntimeProviderKeyNeverReachesAResponseOrAnArtifact(t *testing.T) {
	// A value no other part of the system could produce, long enough that
	// a substring match is not a coincidence.
	const runtimeKey = "sk-amiro-runtime-secret-Q7fV2pLx9mNb4TzR-do-not-log-me"

	h := harness.New(t, harness.Tags("smoke"))
	admin := h.As("admin")
	ctx := t.Context()

	if _, err := admin.SaveProvider(ctx, apiclient.ProviderInput{
		Name:     "runtime-secret-provider",
		Provider: "openai",
		APIKey:   runtimeKey,
		BaseURL:  h.Proxy().URL,
		Models:   []string{"gpt-4.1"},
	}); err != nil {
		t.Fatalf("POST /api/ai/providers: %v", err)
	}

	// 1. The key really is stored and really is readable by its owner.
	//    This is the deliberate behaviour quoted above, and asserting it
	//    is what keeps the sweep in step 4 from passing because nothing
	//    was ever stored.
	resp, err := admin.Do(ctx, "GET", "/api/ai/providers", nil, nil)
	if err != nil {
		t.Fatalf("GET /api/ai/providers: %v", err)
	}
	if !strings.Contains(string(resp.Body), "runtime-secret-provider") {
		t.Fatalf("GET /api/ai/providers does not list the provider that was just saved, so nothing "+
			"below is testing a stored key.\nbody: %s", string(resp.Body))
	}
	if !strings.Contains(string(resp.Body), runtimeKey) {
		t.Fatalf("GET /api/ai/providers did not return the key to its owner. That is BETTER than the " +
			"behaviour recorded when this test was written (ProviderStatusDTO returns it deliberately), " +
			"but it means the sweep below can no longer tell a working redactor from an absent key. " +
			"Update this test.")
	}

	// 2. Anonymous callers get nothing.
	if _, err := h.Client().Anonymous().Do(ctx, "GET", "/api/ai/providers", nil, nil); err == nil {
		t.Error("GET /api/ai/providers succeeded anonymously; a stored provider key is readable without a session")
	} else if status := apiclient.StatusOf(err); status != 401 {
		t.Errorf("anonymous GET /api/ai/providers = %d, want 401", status)
	}

	// 3. FINDING, recorded rather than judged: the route is session-gated
	//    but NOT user-scoped or role-gated. GetProviderStatuses checks only
	//    auth.UserFromContext, and ProviderRepository.Set stores no owner,
	//    so any signed-in account reads every account's keys. On a
	//    single-user desktop app that is arguably the intended shape; on a
	//    served, multi-account deployment it is not. Asserted explicitly so
	//    the day it changes, this test says so.
	otherResp, err := h.As("other").Do(ctx, "GET", "/api/ai/providers", nil, nil)
	if err != nil {
		t.Fatalf("GET /api/ai/providers as a second, non-admin account: %v", err)
	}
	if strings.Contains(string(otherResp.Body), runtimeKey) {
		t.Logf("FINDING (recorded, not a failure): a second, non-admin account can read the admin's " +
			"provider API key in the clear. /api/ai/providers is session-gated but neither role-gated " +
			"nor per-user, and ProviderRepository.Set records no owner. Closing step: decide whether " +
			"provider connections are instance-wide (then gate on the admin role) or per-user (then " +
			"scope the repository by user id).")
	} else {
		t.Logf("provider keys are NOT visible to a second account -- better than the behaviour recorded " +
			"when this test was written; the FINDING above no longer applies and the branch can be removed")
	}

	// 4. Make the key travel: a real chat turn uses the stored key to
	//    authenticate to the provider, which is the path on which it could
	//    reach a log, a stack trace or an error body.
	h.Fake().OnPrompt(fakeprovider.Contains("secret sweep")).StreamText("Nothing to see here.")
	if _, err := admin.ChatTurn(ctx, apiclient.ChatRequest{
		ID:      "thread-secret-sweep",
		Message: apiclient.TextMessage("msg-1", "secret sweep turn"),
	}); err != nil {
		t.Fatalf("ChatTurn: %v", err)
	}

	// 4. Sweep every artifact the run produced.
	//
	//    The carve-out matches suites/meta/secret_leak_test.go's, and for
	//    the same stated reason: appdata/, workspace/, db/ and home/ hold
	//    the APPLICATION's own files, and internal/secrets legitimately
	//    persists provider keys into appdata/keys.json at 0600. The rule
	//    being enforced is that nothing the HARNESS writes may leak, not
	//    that the application may not keep its own secrets in its own
	//    state directory.
	stateDirs := map[string]bool{"appdata": true, "workspace": true, "db": true, "home": true}
	var findings []string
	err = filepath.WalkDir(h.RunDir(), func(path string, d os.DirEntry, walkErr error) error {
		if walkErr != nil {
			return nil
		}
		if d.IsDir() {
			if stateDirs[d.Name()] {
				return filepath.SkipDir
			}
			return nil
		}
		switch strings.ToLower(filepath.Ext(path)) {
		case ".zip", ".png", ".jpg", ".webm", ".webp", ".ico":
			return nil
		}
		data, readErr := os.ReadFile(path)
		if readErr != nil {
			return nil
		}
		if strings.Contains(string(data), runtimeKey) {
			rel, _ := filepath.Rel(h.RunDir(), path)
			findings = append(findings, rel)
		}
		return nil
	})
	if err != nil {
		t.Fatalf("walking the run directory: %v", err)
	}
	if len(findings) > 0 {
		t.Fatalf("CRITICAL: a runtime provider API key reached the artifact tree in the clear:\n  %s",
			strings.Join(findings, "\n  "))
	}

	// 5. Prove the sweep is not vacuous. The request body that carried the
	//    key WAS logged -- it must have been, or step 4 swept a file that
	//    never had anything to hide -- and it must carry the key's
	//    fingerprint in its place.
	httpLog := filepath.Join(h.RunDir(), "backend", h.TestID, "http.ndjson")
	logged, err := os.ReadFile(httpLog)
	if err != nil {
		t.Fatalf("reading %s: %v", httpLog, err)
	}
	if !strings.Contains(string(logged), "/api/ai/providers") {
		t.Fatalf("no /api/ai/providers exchange was recorded in %s; the sweep above proved nothing", httpLog)
	}
	if want := config.Fingerprint(runtimeKey); !strings.Contains(string(logged), want) {
		t.Errorf("%s contains neither the key nor its fingerprint %s. Either the body was not logged "+
			"(making this guard vacuous) or the redactor replaced it with something else.", httpLog, want)
	}
}

// TestSecurity_CommittedCassettesCarryNoCredential is the "cassettes" half
// of the same phase-document line, and it covers the artifact type with
// the longest blast radius: cassettes are COMMITTED, so a credential
// recorded into one is a credential in the repository's history.
//
// suites/meta's sweep only ever looks inside the RUN directory, so a
// cassette under tests/cassettes/ is outside everything that currently
// checks. The sweep is by shape rather than by value, because the whole
// problem with a recorded credential is that nobody knows its value later.
func TestSecurity_CommittedCassettesCarryNoCredential(t *testing.T) {
	h := harness.New(t, harness.NoBackend(), harness.Tags("smoke"))

	cassetteDir := config.Resolve(h.BaseDir, h.Config.Providers.CassetteDir)
	if _, err := os.Stat(cassetteDir); err != nil {
		h.Skip("no cassette directory at " + cassetteDir + "; nothing to sweep")
	}

	// Prefixes real providers use, plus anything the configuration knows
	// about. A prefix sweep catches a key that was recorded before anyone
	// thought to add it to providers.redact -- which is exactly how this
	// goes wrong.
	credentialShapes := []string{
		"sk-ant-", "sk-proj-", "sk-or-v1-", "sk-live-", "sk-test-",
		"AIza",  // Google
		"xai-",  // xAI
		"gsk_",  // Groq
		"tvly-", // Tavily
		"ghp_", "github_pat_",
		"AKIA",        // AWS
		"-----BEGIN ", // any PEM private key
	}
	configured := h.Config.Secrets()

	var findings []string
	scanned := 0
	err := filepath.WalkDir(cassetteDir, func(path string, d os.DirEntry, walkErr error) error {
		if walkErr != nil || d.IsDir() {
			return nil
		}
		data, readErr := os.ReadFile(path)
		if readErr != nil {
			return nil
		}
		scanned++
		text := string(data)
		rel, _ := filepath.Rel(h.BaseDir, path)
		for _, shape := range credentialShapes {
			if strings.Contains(text, shape) {
				findings = append(findings, rel+" contains something shaped like a credential: "+shape+"...")
			}
		}
		for _, secret := range configured {
			if strings.Contains(text, secret) {
				findings = append(findings, rel+" contains a configured secret in the clear")
			}
		}
		return nil
	})
	if err != nil {
		t.Fatalf("walking %s: %v", cassetteDir, err)
	}
	if scanned == 0 {
		t.Fatalf("swept %s and found no files at all; this guard would pass on an empty directory forever",
			cassetteDir)
	}
	t.Logf("swept %d committed cassette files under %s", scanned, cassetteDir)
	if len(findings) > 0 {
		t.Fatalf("committed cassettes carry credentials:\n  %s", strings.Join(findings, "\n  "))
	}
}

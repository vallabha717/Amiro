package mcp

import (
	"encoding/json"
	"testing"
)

func TestServerConfig_UnmarshalsStdioConfigByCommandPresence(t *testing.T) {
	var c ServerConfig
	err := json.Unmarshal([]byte(`{"command":"npx","args":["-y","srv"],"env":{"K":"V"}}`), &c)
	if err != nil {
		t.Fatalf("Unmarshal: %v", err)
	}
	if c.Stdio == nil || c.Remote != nil {
		t.Fatalf("got %+v, want a stdio-only config", c)
	}
	if c.Stdio.Command != "npx" || len(c.Stdio.Args) != 2 || c.Stdio.Env["K"] != "V" {
		t.Fatalf("stdio = %+v", c.Stdio)
	}
}

func TestServerConfig_UnmarshalsRemoteConfigByURLPresence(t *testing.T) {
	var c ServerConfig
	err := json.Unmarshal([]byte(`{"url":"https://example.invalid/mcp","headers":{"Authorization":"Bearer x"}}`), &c)
	if err != nil {
		t.Fatalf("Unmarshal: %v", err)
	}
	if c.Remote == nil || c.Stdio != nil {
		t.Fatalf("got %+v, want a remote-only config", c)
	}
	if c.Remote.URL != "https://example.invalid/mcp" || c.Remote.Headers["Authorization"] != "Bearer x" {
		t.Fatalf("remote = %+v", c.Remote)
	}
}

func TestServerConfig_UnmarshalRejectsConfigWithNeitherCommandNorURL(t *testing.T) {
	var c ServerConfig
	err := json.Unmarshal([]byte(`{"foo":"bar"}`), &c)
	if err != ErrInvalidServerConfig {
		t.Fatalf("err = %v, want ErrInvalidServerConfig", err)
	}
}

func TestServerConfig_MarshalRoundTripsStdio(t *testing.T) {
	c := ServerConfig{Stdio: &StdioConfig{Command: "npx", Args: []string{"-y"}}}
	b, err := json.Marshal(c)
	if err != nil {
		t.Fatalf("Marshal: %v", err)
	}
	var back ServerConfig
	if err := json.Unmarshal(b, &back); err != nil {
		t.Fatalf("Unmarshal: %v", err)
	}
	if back.Stdio == nil || back.Stdio.Command != "npx" {
		t.Fatalf("round-tripped to %+v", back)
	}
}

func TestServerConfig_MarshalRoundTripsRemote(t *testing.T) {
	c := ServerConfig{Remote: &RemoteConfig{URL: "https://example.invalid"}}
	b, err := json.Marshal(c)
	if err != nil {
		t.Fatalf("Marshal: %v", err)
	}
	var back ServerConfig
	if err := json.Unmarshal(b, &back); err != nil {
		t.Fatalf("Unmarshal: %v", err)
	}
	if back.Remote == nil || back.Remote.URL != "https://example.invalid" {
		t.Fatalf("round-tripped to %+v", back)
	}
}

func TestServerConfig_MarshalEmptyConfigErrors(t *testing.T) {
	_, err := json.Marshal(ServerConfig{})
	if err == nil {
		t.Fatal("expected an error marshaling a config with neither stdio nor remote set")
	}
}

func TestServerConfig_UnmarshalDoesNotWrapInExtraObject(t *testing.T) {
	// Wire compatibility check: no {"stdio": {...}} or {"type": "stdio", ...}
	// wrapper -- the TS union is duck-typed directly on the top-level object
	// (is-mcp-config.ts), and request bodies from an eventual Phase 7
	// frontend rewire will still send that exact shape.
	var c ServerConfig
	if err := json.Unmarshal([]byte(`{"command":"echo"}`), &c); err != nil {
		t.Fatalf("Unmarshal: %v", err)
	}
	if c.Stdio == nil {
		t.Fatal("expected the bare object to parse directly as a stdio config")
	}
}

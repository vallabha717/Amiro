// Package apiclient is a typed HTTP client for Amiro's /api/* surface.
//
// It is TEST-OWNED: the request and response types here are transcribed
// from the handlers, not generated from them. That is deliberate. A
// generated client makes a breaking API change invisible -- the client
// changes shape in lockstep and every test still compiles. A transcribed
// one turns the same change into a compile error or a failing decode, which
// is the signal the suite exists to produce.
//
// Every exchange is written to backend/<test-id>/http.ndjson, redacted at
// write time, and mirrored as an event on the merged timeline.
package apiclient

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"path"
	"strings"
	"time"

	"amiro/tests/harness/logging"
)

// Client talks to one backend as one identity.
//
// A Client is immutable once built: As() returns a new one carrying a
// session rather than mutating the receiver, so two identities in the same
// test cannot race on a shared bearer token. That is not theoretical -- the
// canonical "can Bob see Alice's data?" test holds both at once.
type Client struct {
	BaseURL string
	// Token is the sidecar shared secret (middleware.RequireToken). Required
	// on every request including /health.
	Token string
	// Session is the per-user bearer (internal/auth). Empty for anonymous
	// routes and for the pre-registration ones.
	Session string
	// Identity labels this client in the log: "admin", "user", "other".
	Identity string

	http    *http.Client
	log     *logging.Logger
	surface string
	address string
	ndjson  string

	logBodies    bool
	maxBodyBytes int
}

// Options configure a client.
type Options struct {
	BaseURL string
	Token   string
	Log     *logging.Logger
	// NDJSONPath is where exchanges are recorded, relative to the run
	// directory: "backend/<test-id>/http.ndjson".
	NDJSONPath   string
	Surface      string
	Address      string
	Timeout      time.Duration
	LogBodies    bool
	MaxBodyBytes int
}

func New(opts Options) *Client {
	timeout := opts.Timeout
	if timeout <= 0 {
		// Generous, because a chat turn streams. Per-test deadlines come
		// from run.testTimeout and the context, not from here; this is only
		// a backstop against a connection that will never answer.
		timeout = 5 * time.Minute
	}
	maxBody := opts.MaxBodyBytes
	if maxBody <= 0 {
		maxBody = 64 << 10
	}
	return &Client{
		BaseURL:      strings.TrimSuffix(opts.BaseURL, "/"),
		Token:        opts.Token,
		http:         &http.Client{Timeout: timeout},
		log:          opts.Log,
		surface:      opts.Surface,
		address:      opts.Address,
		ndjson:       opts.NDJSONPath,
		logBodies:    opts.LogBodies,
		maxBodyBytes: maxBody,
	}
}

// As returns a copy of the client authenticated as the given session.
func (c *Client) As(identity, session string) *Client {
	clone := *c
	clone.Session = session
	clone.Identity = identity
	return &clone
}

// Anonymous returns a copy with no session, for testing that a route
// actually requires one.
func (c *Client) Anonymous() *Client {
	clone := *c
	clone.Session = ""
	clone.Identity = "anonymous"
	return &clone
}

// Error is a non-2xx response, carrying enough to assert on without
// re-reading the log.
type Error struct {
	Method  string
	Path    string
	Status  int
	Message string
	Body    string
}

func (e *Error) Error() string {
	msg := e.Message
	if msg == "" {
		msg = strings.TrimSpace(e.Body)
	}
	if len(msg) > 300 {
		msg = msg[:300] + "..."
	}
	return fmt.Sprintf("%s %s: %d: %s", e.Method, e.Path, e.Status, msg)
}

// StatusOf returns the HTTP status carried by err, or 0 if err is not an
// API error. For assertions of the form "this must be 403, not 404".
func StatusOf(err error) int {
	var apiErr *Error
	if ok := asError(err, &apiErr); ok {
		return apiErr.Status
	}
	return 0
}

func asError(err error, target **Error) bool {
	for err != nil {
		if e, ok := err.(*Error); ok {
			*target = e
			return true
		}
		u, ok := err.(interface{ Unwrap() error })
		if !ok {
			return false
		}
		err = u.Unwrap()
	}
	return false
}

// Response is one exchange's outcome, for the callers that need the raw
// status or headers rather than a decoded body.
type Response struct {
	Status  int
	Header  http.Header
	Body    []byte
	Elapsed time.Duration
}

// Do performs a request, decodes a JSON response into out (if out is
// non-nil), and records the exchange.
//
// A non-2xx status is returned as *Error rather than decoded into out. A
// test that means to assert on a failure asks for the error; a test that
// does not gets one instead of a zero-valued struct it would then assert
// nonsense about.
func (c *Client) Do(ctx context.Context, method, apiPath string, body, out any) (*Response, error) {
	var reqBody []byte
	var reader io.Reader
	if body != nil {
		var err error
		reqBody, err = json.Marshal(body)
		if err != nil {
			return nil, fmt.Errorf("encoding %s %s request: %w", method, apiPath, err)
		}
		reader = bytes.NewReader(reqBody)
	}

	req, err := http.NewRequestWithContext(ctx, method, c.BaseURL+apiPath, reader)
	if err != nil {
		return nil, err
	}
	if reqBody != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	c.authorize(req)

	started := time.Now()
	resp, err := c.http.Do(req)
	elapsed := time.Since(started)
	if err != nil {
		c.record(method, apiPath, 0, elapsed, reqBody, nil, err)
		return nil, fmt.Errorf("%s %s: %w", method, apiPath, err)
	}
	defer resp.Body.Close()

	respBody, readErr := io.ReadAll(resp.Body)
	if readErr != nil {
		c.record(method, apiPath, resp.StatusCode, elapsed, reqBody, nil, readErr)
		return nil, fmt.Errorf("%s %s: reading response: %w", method, apiPath, readErr)
	}
	c.record(method, apiPath, resp.StatusCode, elapsed, reqBody, respBody, nil)

	r := &Response{Status: resp.StatusCode, Header: resp.Header, Body: respBody, Elapsed: elapsed}
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return r, &Error{Method: method, Path: apiPath, Status: resp.StatusCode,
			Message: messageOf(respBody), Body: string(respBody)}
	}
	if out != nil && len(bytes.TrimSpace(respBody)) > 0 {
		if err := json.Unmarshal(respBody, out); err != nil {
			return r, fmt.Errorf("%s %s: decoding response into %T: %w\nbody: %s",
				method, apiPath, out, err, truncate(string(respBody), 500))
		}
	}
	return r, nil
}

func (c *Client) authorize(req *http.Request) {
	// The shared secret goes on every request, /health included: a
	// sidecar-mode server (no dashboard) guards the whole mux with
	// middleware.RequireToken. Both spellings are sent because the server
	// still accepts the legacy one and the suite tests it as shipped.
	req.Header.Set("X-Amiro-Token", c.Token)
	req.Header.Set("X-BetterChatbot-Token", c.Token)
	if c.Session != "" {
		req.Header.Set("Authorization", "Bearer "+c.Session)
	}
}

// exchange is one line of http.ndjson.
//
// Request and Response are `body`, not string, and that distinction is
// load-bearing: a JSON body embedded as a STRING is opaque to the
// redactor's field-name pass, so `{"token":"abc..."}` inside a quoted
// string would sail past `providers.redact` and land in the log intact.
// Embedding it as JSON lets the redactor walk into it. This is not
// hypothetical -- suites/meta caught exactly that leak, with a real session
// bearer token, the first time it ran.
type exchange struct {
	TS       time.Time `json:"ts"`
	Test     string    `json:"test,omitempty"`
	Identity string    `json:"identity,omitempty"`
	Method   string    `json:"method"`
	Path     string    `json:"path"`
	Status   int       `json:"status"`
	MS       int64     `json:"ms"`
	Request  *body     `json:"request,omitempty"`
	Response *body     `json:"response,omitempty"`
	Error    string    `json:"error,omitempty"`
}

// body is a recorded request or response payload. It marshals as JSON when
// the payload is JSON, and as a plain string otherwise -- an HTML error
// page or a binary upload is still worth recording, just not worth
// pretending is structured.
type body struct {
	raw []byte
}

// newBody prepares a payload for recording, truncating it to max bytes.
//
// Truncation happens BEFORE the JSON check, so an oversized body degrades
// to a string rather than to nothing. A 2 MB response recorded as its first
// 64 KB of text is worth having; a dropped one is not.
func newBody(raw []byte, max int) *body {
	if len(raw) == 0 {
		return nil
	}
	if max > 0 && len(raw) > max {
		return &body{raw: fmt.Appendf(nil, "%q", truncate(string(raw), max))}
	}
	if json.Valid(raw) {
		return &body{raw: raw}
	}
	return &body{raw: fmt.Appendf(nil, "%q", string(raw))}
}

func (b *body) MarshalJSON() ([]byte, error) {
	if b == nil || len(b.raw) == 0 {
		return []byte("null"), nil
	}
	return b.raw, nil
}

func (c *Client) record(method, apiPath string, status int, elapsed time.Duration, req, resp []byte, err error) {
	if c.log == nil {
		return
	}
	e := exchange{
		TS: time.Now().UTC(), Test: c.address, Identity: c.Identity,
		Method: method, Path: apiPath, Status: status, MS: elapsed.Milliseconds(),
	}
	if err != nil {
		e.Error = err.Error()
	}
	if c.logBodies {
		e.Request = newBody(req, c.maxBodyBytes)
		e.Response = newBody(resp, c.maxBodyBytes)
	}
	if c.ndjson != "" {
		c.log.NDJSON(c.ndjson, e)
	}
	// Empty fields are omitted rather than logged blank: an anonymous
	// request has no identity, and `"identity":""` on every one of them is
	// noise in a file whose value is being scannable.
	detail := map[string]any{"status": status, "ms": elapsed.Milliseconds()}
	if c.Identity != "" {
		detail["identity"] = c.Identity
	}
	c.log.Emit(logging.Event{Surface: c.surface, Test: c.address, Kind: logging.KindHTTP,
		Msg: method + " " + apiPath, Detail: detail})
}

// messageOf pulls the error text out of a JSON error body. The handlers use
// both {"error":...} and {"message":...}, so both are read -- guessing one
// would make half the failures report an empty reason.
func messageOf(body []byte) string {
	var payload struct {
		Error   string `json:"error"`
		Message string `json:"message"`
	}
	if err := json.Unmarshal(body, &payload); err != nil {
		return ""
	}
	if payload.Error != "" {
		return payload.Error
	}
	return payload.Message
}

func truncate(s string, max int) string {
	if max <= 0 || len(s) <= max {
		return s
	}
	return s[:max] + fmt.Sprintf("... [truncated, %d bytes total]", len(s))
}

// Convenience wrappers. Every typed method in this package funnels through
// one of these, so there is exactly one place that knows how a request is
// shaped and logged.

func (c *Client) Get(ctx context.Context, p string, out any) error {
	_, err := c.Do(ctx, http.MethodGet, p, nil, out)
	return err
}

func (c *Client) Post(ctx context.Context, p string, body, out any) error {
	_, err := c.Do(ctx, http.MethodPost, p, body, out)
	return err
}

func (c *Client) Put(ctx context.Context, p string, body, out any) error {
	_, err := c.Do(ctx, http.MethodPut, p, body, out)
	return err
}

func (c *Client) Delete(ctx context.Context, p string, out any) error {
	_, err := c.Do(ctx, http.MethodDelete, p, nil, out)
	return err
}

// Health is the readiness probe, also useful as an "is it still up?"
// assertion mid-test.
func (c *Client) Health(ctx context.Context) error {
	var out struct {
		Status string `json:"status"`
	}
	if err := c.Get(ctx, "/health", &out); err != nil {
		return err
	}
	if out.Status != "ok" {
		return fmt.Errorf("/health returned status %q, want \"ok\"", out.Status)
	}
	return nil
}

// join builds a path with escaped segments, so an id containing a slash
// cannot silently address a different route.
func join(base string, segments ...string) string {
	parts := make([]string, 0, len(segments)+1)
	parts = append(parts, base)
	for _, s := range segments {
		parts = append(parts, pathEscape(s))
	}
	return path.Join(parts...)
}

func pathEscape(s string) string {
	return strings.ReplaceAll(strings.ReplaceAll(s, "/", "%2F"), "?", "%3F")
}

// readAll drains a response body with a cap, so a runaway response cannot
// exhaust the test process's memory before anyone can assert on it.
func readAll(resp *http.Response) ([]byte, error) {
	const maxResponse = 64 << 20
	return io.ReadAll(io.LimitReader(resp.Body, maxResponse))
}

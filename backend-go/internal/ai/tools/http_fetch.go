package tools

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"strings"
	"time"
)

// httpFetchInput mirrors httpFetchSchema (lib/ai/tools/http/fetch.ts).
type httpFetchInput struct {
	URL     string            `json:"url"`
	Method  string            `json:"method"`
	Headers map[string]string `json:"headers"`
	Body    string            `json:"body"`
	Timeout int               `json:"timeout"`
}

// httpFetchOutput mirrors the TS execute's success return shape.
type httpFetchOutput struct {
	Status     int               `json:"status"`
	StatusText string            `json:"statusText"`
	Headers    map[string]string `json:"headers"`
	Body       any               `json:"body"`
	OK         bool              `json:"ok"`
	URL        string            `json:"url"`
}

// httpFetchError mirrors the TS execute's .ifFail return shape --
// message-parts.tsx / the model don't branch on a distinct error type, they
// just see whatever JSON the tool "succeeded" with, same as TS's
// safe().ifFail() pattern which never rejects the tool call itself.
type httpFetchError struct {
	IsError  bool   `json:"isError"`
	Error    string `json:"error"`
	Solution string `json:"solution"`
}

// httpFetchTool ports lib/ai/tools/http/fetch.ts's httpFetchTool: a real
// outbound HTTP request, run server-side (the frontend's browser fetch()
// would hit CORS on arbitrary third-party APIs; the TS version already ran
// this in the Next.js API route for the same reason).
func httpFetchTool() Definition {
	return Definition{
		Name:    NameHttp,
		Toolkit: ToolkitHttp,
		// External, not read: the model picks the method and the body, so
		// this tool can PUT and DELETE against anything reachable. That is
		// a different kind of thing from web_search, which can only ever
		// look something up.
		Risk: RiskExternal,
		Description: "Make HTTP requests to any URL. Can be used to fetch data from APIs, send data to " +
			"servers, or interact with web services.",
		ParametersSchema: json.RawMessage(`{
			"type": "object",
			"properties": {
				"url": {"type": "string", "description": "The URL to make the HTTP request to"},
				"method": {
					"type": "string",
					"enum": ["GET", "POST", "PUT", "DELETE", "PATCH", "HEAD", "OPTIONS"],
					"description": "The HTTP method to use",
					"default": "GET"
				},
				"headers": {
					"type": "object",
					"description": "Headers to include in the request",
					"additionalProperties": true
				},
				"body": {
					"type": "string",
					"description": "The request body (for POST, PUT, PATCH requests). Should be a JSON string if sending JSON data."
				},
				"timeout": {
					"type": "number",
					"description": "Request timeout in milliseconds",
					"default": 10000
				}
			},
			"required": ["url"]
		}`),
		Execute: executeHttpFetch,
	}
}

func executeHttpFetch(ctx context.Context, rawInput json.RawMessage) (any, error) {
	var in httpFetchInput
	if err := json.Unmarshal(rawInput, &in); err != nil {
		return httpFetchError{IsError: true, Error: err.Error(), Solution: solutionText}, nil
	}
	method := strings.ToUpper(in.Method)
	if method == "" {
		method = http.MethodGet
	}
	timeout := time.Duration(in.Timeout) * time.Millisecond
	if in.Timeout <= 0 {
		timeout = 10 * time.Second
	}

	reqCtx, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()

	var body io.Reader
	if in.Body != "" && method != http.MethodGet && method != http.MethodHead {
		body = strings.NewReader(in.Body)
	}

	req, err := http.NewRequestWithContext(reqCtx, method, in.URL, body)
	if err != nil {
		return httpFetchError{IsError: true, Error: err.Error(), Solution: solutionText}, nil
	}
	for k, v := range in.Headers {
		req.Header.Set(k, v)
	}

	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		return httpFetchError{IsError: true, Error: err.Error(), Solution: solutionText}, nil
	}
	defer resp.Body.Close()

	respBodyBytes, err := io.ReadAll(resp.Body)
	if err != nil {
		return httpFetchError{IsError: true, Error: err.Error(), Solution: solutionText}, nil
	}

	respHeaders := make(map[string]string, len(resp.Header))
	for k := range resp.Header {
		respHeaders[k] = resp.Header.Get(k)
	}

	var respBody any
	contentType := resp.Header.Get("Content-Type")
	if strings.Contains(contentType, "application/json") {
		if jsonErr := json.Unmarshal(respBodyBytes, &respBody); jsonErr != nil {
			respBody = string(respBodyBytes)
		}
	} else {
		respBody = string(respBodyBytes)
	}

	return httpFetchOutput{
		Status:     resp.StatusCode,
		StatusText: http.StatusText(resp.StatusCode),
		Headers:    respHeaders,
		Body:       respBody,
		OK:         resp.StatusCode >= 200 && resp.StatusCode < 300,
		URL:        resp.Request.URL.String(),
	}, nil
}

const solutionText = "An HTTP request error occurred. This could be due to network issues, invalid URL, " +
	"timeout, or server errors. Check the URL and try again. For CORS issues, the server needs to allow " +
	"your origin."

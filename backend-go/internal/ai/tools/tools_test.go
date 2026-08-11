package tools

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestDefaults_ReturnsNineToolsAcrossFourToolkits(t *testing.T) {
	defs := Defaults()
	if len(defs) != 9 {
		t.Fatalf("got %d tools, want 9 (4 visualization + 1 http + 2 webSearch + 2 code)", len(defs))
	}
	byToolkit := map[string]int{}
	for _, d := range defs {
		byToolkit[d.Toolkit]++
	}
	want := map[string]int{ToolkitVisualization: 4, ToolkitHttp: 1, ToolkitWebSearch: 2, ToolkitCode: 2}
	for k, v := range want {
		if byToolkit[k] != v {
			t.Fatalf("toolkit %q: got %d tools, want %d (%+v)", k, byToolkit[k], v, byToolkit)
		}
	}
}

func TestDefaults_CodeToolsHaveNilExecute(t *testing.T) {
	defs := Defaults()
	for _, name := range []string{NameJavascriptExecution, NamePythonExecution} {
		d, ok := FindByName(defs, name)
		if !ok {
			t.Fatalf("tool %q not found", name)
		}
		if d.Execute != nil {
			t.Fatalf("tool %q: got non-nil Execute, want nil (client-executed tool)", name)
		}
	}
}

func TestDefaults_EveryNonCodeToolHasExecute(t *testing.T) {
	defs := Defaults()
	for _, d := range defs {
		if d.Toolkit == ToolkitCode {
			continue
		}
		if d.Execute == nil {
			t.Fatalf("tool %q (toolkit %q): got nil Execute, want non-nil", d.Name, d.Toolkit)
		}
	}
}

func TestFilter_NilAllowedToolkitsReturnsEverything(t *testing.T) {
	defs := Defaults()
	got := Filter(defs, nil, nil)
	if len(got) != len(defs) {
		t.Fatalf("got %d tools, want all %d", len(got), len(defs))
	}
}

func TestFilter_EmptyAllowedToolkitsReturnsNone(t *testing.T) {
	defs := Defaults()
	empty := []string{}
	got := Filter(defs, &empty, nil)
	if len(got) != 0 {
		t.Fatalf("got %+v, want none", got)
	}
}

func TestFilter_SpecificToolkitReturnsOnlyItsTools(t *testing.T) {
	defs := Defaults()
	allowed := []string{ToolkitVisualization}
	got := Filter(defs, &allowed, nil)
	if len(got) != 4 {
		t.Fatalf("got %d tools, want 4", len(got))
	}
	for _, d := range got {
		if d.Toolkit != ToolkitVisualization {
			t.Fatalf("got tool %q from toolkit %q, want only visualization", d.Name, d.Toolkit)
		}
	}
}

func TestFilter_DefaultToolNamesTakesPriorityOverToolkits(t *testing.T) {
	defs := Defaults()
	empty := []string{} // would select nothing on its own
	got := Filter(defs, &empty, []string{NameCreatePieChart, NameHttp})
	if len(got) != 2 {
		t.Fatalf("got %d tools, want 2: %+v", len(got), got)
	}
	names := map[string]bool{}
	for _, d := range got {
		names[d.Name] = true
	}
	if !names[NameCreatePieChart] || !names[NameHttp] {
		t.Fatalf("got %+v, want createPieChart and http", names)
	}
}

func TestFindByName_UnknownNameReturnsFalse(t *testing.T) {
	if _, ok := FindByName(Defaults(), "does-not-exist"); ok {
		t.Fatal("got ok=true for unknown tool name")
	}
}

func TestVisualizationExecute_AlwaysReturnsSuccessString(t *testing.T) {
	defs := Defaults()
	for _, name := range []string{NameCreatePieChart, NameCreateBarChart, NameCreateLineChart, NameCreateTable} {
		d, _ := FindByName(defs, name)
		out, err := d.Execute(context.Background(), json.RawMessage(`{}`))
		if err != nil {
			t.Fatalf("%q: unexpected error: %v", name, err)
		}
		if out != "Success" {
			t.Fatalf("%q: got %+v, want \"Success\"", name, out)
		}
	}
}

func TestHttpFetchExecute_MakesRealRequestAndReturnsJSONBody(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusCreated)
		_, _ = w.Write([]byte(`{"ok":true}`))
	}))
	defer srv.Close()

	d, _ := FindByName(Defaults(), NameHttp)
	input, _ := json.Marshal(map[string]any{"url": srv.URL, "method": "POST", "body": "{}"})
	out, err := d.Execute(context.Background(), input)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	result, ok := out.(httpFetchOutput)
	if !ok {
		t.Fatalf("got %T, want httpFetchOutput", out)
	}
	if result.Status != 201 || !result.OK {
		t.Fatalf("got status=%d ok=%v, want 201/true", result.Status, result.OK)
	}
	body, _ := result.Body.(map[string]any)
	if body["ok"] != true {
		t.Fatalf("got body=%+v, want decoded JSON {ok:true}", result.Body)
	}
}

func TestHttpFetchExecute_NetworkFailureReturnsToolErrorNotGoError(t *testing.T) {
	d, _ := FindByName(Defaults(), NameHttp)
	input, _ := json.Marshal(map[string]any{"url": "http://127.0.0.1:1/unreachable"})
	out, err := d.Execute(context.Background(), input)
	if err != nil {
		t.Fatalf("got Go error %v, want a tool-level httpFetchError instead (matches TS's safe().ifFail())", err)
	}
	result, ok := out.(httpFetchError)
	if !ok || !result.IsError {
		t.Fatalf("got %+v, want httpFetchError{IsError:true}", out)
	}
}

func TestWebSearchExecute_MissingAPIKeyReturnsToolError(t *testing.T) {
	t.Setenv("EXA_API_KEY", "")
	d, _ := FindByName(Defaults(), NameWebSearch)
	input, _ := json.Marshal(map[string]any{"query": "test"})
	out, err := d.Execute(context.Background(), input)
	if err != nil {
		t.Fatalf("got Go error %v, want a tool-level exaToolError", err)
	}
	result, ok := out.(exaToolError)
	if !ok || !result.IsError || !strings.Contains(result.Error, "EXA_API_KEY") {
		t.Fatalf("got %+v, want exaToolError mentioning EXA_API_KEY", out)
	}
}

func TestWebContentExecute_MissingAPIKeyReturnsToolError(t *testing.T) {
	t.Setenv("EXA_API_KEY", "")
	d, _ := FindByName(Defaults(), NameWebContent)
	input, _ := json.Marshal(map[string]any{"urls": []string{"https://example.com"}})
	out, err := d.Execute(context.Background(), input)
	if err != nil {
		t.Fatalf("got Go error %v, want a tool-level exaToolError", err)
	}
	if result, ok := out.(exaToolError); !ok || !result.IsError {
		t.Fatalf("got %+v, want exaToolError{IsError:true}", out)
	}
}

func TestParametersSchema_EveryToolIsValidJSON(t *testing.T) {
	for _, d := range Defaults() {
		var v any
		if err := json.Unmarshal(d.ParametersSchema, &v); err != nil {
			t.Fatalf("tool %q: ParametersSchema is not valid JSON: %v", d.Name, err)
		}
	}
}

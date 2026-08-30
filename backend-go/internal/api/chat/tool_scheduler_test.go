package chat

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http/httptest"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"amiro/backend/internal/agent/permission"
	bifrostai "amiro/backend/internal/ai/bifrost"
	"amiro/backend/internal/ai/tools"
	"amiro/backend/internal/ai/uimessage"
)

// gatedTool returns a tool that blocks until release is closed, recording
// peak concurrency along the way. Both properties the scheduler exists for
// -- that parallel calls overlap and that sequential ones never do -- are
// observable from the peak alone.
type concurrencyProbe struct {
	mu      sync.Mutex
	live    int
	peak    int
	order   []string
	started chan struct{}
}

func (p *concurrencyProbe) enter(name string) {
	p.mu.Lock()
	p.live++
	if p.live > p.peak {
		p.peak = p.live
	}
	p.order = append(p.order, name)
	p.mu.Unlock()
}

func (p *concurrencyProbe) exit() {
	p.mu.Lock()
	p.live--
	p.mu.Unlock()
}

func (p *concurrencyProbe) peakConcurrency() int {
	p.mu.Lock()
	defer p.mu.Unlock()
	return p.peak
}

func (p *concurrencyProbe) callOrder() []string {
	p.mu.Lock()
	defer p.mu.Unlock()
	return append([]string(nil), p.order...)
}

// TestToolScheduler_ParallelToolsActuallyOverlap is the whole point of the
// scheduler: before it, every tool call in a step ran inline in
// OnToolCallReady, so N reads cost N round trips end to end. Each tool here
// sleeps, so if execution were still serialized the peak concurrency would
// be 1 and the wall time ~4 sleeps instead of ~1.
func TestToolScheduler_ParallelToolsActuallyOverlap(t *testing.T) {
	probe := &concurrencyProbe{}
	const sleep = 60 * time.Millisecond

	mk := func(name string) tools.Definition {
		return tools.Definition{
			Name: name,
			Risk: tools.RiskRead,
			Execute: func(ctx context.Context, _ json.RawMessage) (any, error) {
				probe.enter(name)
				defer probe.exit()
				time.Sleep(sleep)
				return map[string]any{"tool": name}, nil
			},
		}
	}

	activeTools := []tools.Definition{mk("read-a"), mk("read-b"), mk("read-c"), mk("read-d")}
	calls := make([]bifrostai.ToolCall, 0, 4)
	for i, d := range activeTools {
		calls = append(calls, bifrostai.ToolCall{ID: fmt.Sprintf("call-%d", i), Name: d.Name, Arguments: `{}`})
	}

	engine := &fakeStreamEngine{steps: []bifrostai.StepResult{
		{ToolCalls: calls},
		{Text: "done"},
	}}
	sw := uimessage.NewWriter(httptest.NewRecorder())

	start := time.Now()
	_, err := runToolLoop(context.Background(), engine, sw, bifrostai.ResolvedModel{}, "", nil, activeTools, testPerms(), nil)
	elapsed := time.Since(start)
	if err != nil {
		t.Fatalf("runToolLoop: %v", err)
	}

	if got := probe.peakConcurrency(); got < 2 {
		t.Fatalf("peak concurrency = %d, want >= 2 -- tools.Parallel calls must overlap, not run one at a time", got)
	}
	// Four 60ms sleeps serialized is 240ms; overlapped it is ~60ms. Allow
	// generous headroom so a loaded CI box doesn't flake, while still
	// failing loudly if execution regressed to serial.
	if elapsed > 3*sleep {
		t.Fatalf("elapsed = %v, want well under %v -- four parallel tools appear to have run serially", elapsed, 4*sleep)
	}
}

// TestToolScheduler_SequentialToolsNeverOverlap guards the other side of
// the partition. A tool whose risk is anything but read writes something
// -- files, shell, a non-GET request -- and ordering is part of its
// meaning, so overlapping two of them is a correctness bug, not a latency
// win.
func TestToolScheduler_SequentialToolsNeverOverlap(t *testing.T) {
	probe := &concurrencyProbe{}

	mk := func(name string) tools.Definition {
		return tools.Definition{
			Name: name, // zero Risk is unclassified, which is never parallel
			Execute: func(ctx context.Context, _ json.RawMessage) (any, error) {
				probe.enter(name)
				defer probe.exit()
				time.Sleep(20 * time.Millisecond)
				return map[string]any{"tool": name}, nil
			},
		}
	}

	activeTools := []tools.Definition{mk("write-a"), mk("write-b"), mk("write-c")}
	engine := &fakeStreamEngine{steps: []bifrostai.StepResult{
		{ToolCalls: []bifrostai.ToolCall{
			{ID: "call-0", Name: "write-a", Arguments: `{}`},
			{ID: "call-1", Name: "write-b", Arguments: `{}`},
			{ID: "call-2", Name: "write-c", Arguments: `{}`},
		}},
		{Text: "done"},
	}}
	sw := uimessage.NewWriter(httptest.NewRecorder())

	if _, err := runToolLoop(context.Background(), engine, sw, bifrostai.ResolvedModel{}, "", nil, activeTools, testPerms(), nil); err != nil {
		t.Fatalf("runToolLoop: %v", err)
	}

	if got := probe.peakConcurrency(); got != 1 {
		t.Fatalf("peak concurrency = %d, want 1 -- tools that did not declare tools.Parallel must never overlap", got)
	}
	want := []string{"write-a", "write-b", "write-c"}
	got := probe.callOrder()
	for i := range want {
		if got[i] != want[i] {
			t.Fatalf("execution order = %v, want %v -- sequential tools must run in the order the model emitted them", got, want)
		}
	}
}

// TestToolScheduler_ResultsMergeInCallOrderNotCompletionOrder is the
// invariant that makes parallelism safe to ship. The tools here finish in
// reverse order on purpose; the history handed to the next step must still
// read in the order the model asked for them, or the model's own reasoning
// stops being reproducible run to run.
func TestToolScheduler_ResultsMergeInCallOrderNotCompletionOrder(t *testing.T) {
	// first-called sleeps longest, so completion order is exactly reversed.
	delays := map[string]time.Duration{
		"slow": 90 * time.Millisecond,
		"mid":  45 * time.Millisecond,
		"fast": 1 * time.Millisecond,
	}
	mk := func(name string) tools.Definition {
		return tools.Definition{
			Name: name,
			Risk: tools.RiskRead,
			Execute: func(ctx context.Context, _ json.RawMessage) (any, error) {
				time.Sleep(delays[name])
				return map[string]any{"tool": name}, nil
			},
		}
	}

	activeTools := []tools.Definition{mk("slow"), mk("mid"), mk("fast")}
	engine := &fakeStreamEngine{steps: []bifrostai.StepResult{
		{ToolCalls: []bifrostai.ToolCall{
			{ID: "call-0", Name: "slow", Arguments: `{}`},
			{ID: "call-1", Name: "mid", Arguments: `{}`},
			{ID: "call-2", Name: "fast", Arguments: `{}`},
		}},
		{Text: "done"},
	}}
	sw := uimessage.NewWriter(httptest.NewRecorder())

	result, err := runToolLoop(context.Background(), engine, sw, bifrostai.ResolvedModel{}, "", nil, activeTools, testPerms(), nil)
	if err != nil {
		t.Fatalf("runToolLoop: %v", err)
	}

	parts := string(result.Parts)
	iSlow := strings.Index(parts, `"tool-slow"`)
	iMid := strings.Index(parts, `"tool-mid"`)
	iFast := strings.Index(parts, `"tool-fast"`)
	if iSlow < 0 || iMid < 0 || iFast < 0 {
		t.Fatalf("Parts = %s, want all three tool parts present", parts)
	}
	if !(iSlow < iMid && iMid < iFast) {
		t.Fatalf("persisted part order is slow=%d mid=%d fast=%d, want ascending -- results must merge in call order, not completion order", iSlow, iMid, iFast)
	}
}

// TestToolScheduler_RespectsParallelismCeiling pins maxParallelToolCalls to
// 2 and asserts nothing exceeds it. The ceiling is what stops a model that
// asks for thirty reads from opening thirty descriptors at once.
func TestToolScheduler_RespectsParallelismCeiling(t *testing.T) {
	orig := maxParallelToolCalls
	maxParallelToolCalls = 2
	t.Cleanup(func() { maxParallelToolCalls = orig })

	probe := &concurrencyProbe{}
	mk := func(name string) tools.Definition {
		return tools.Definition{
			Name: name,
			Risk: tools.RiskRead,
			Execute: func(ctx context.Context, _ json.RawMessage) (any, error) {
				probe.enter(name)
				defer probe.exit()
				time.Sleep(25 * time.Millisecond)
				return map[string]any{"tool": name}, nil
			},
		}
	}

	var activeTools []tools.Definition
	var calls []bifrostai.ToolCall
	for i := 0; i < 6; i++ {
		name := fmt.Sprintf("read-%d", i)
		activeTools = append(activeTools, mk(name))
		calls = append(calls, bifrostai.ToolCall{ID: fmt.Sprintf("call-%d", i), Name: name, Arguments: `{}`})
	}

	engine := &fakeStreamEngine{steps: []bifrostai.StepResult{{ToolCalls: calls}, {Text: "done"}}}
	sw := uimessage.NewWriter(httptest.NewRecorder())

	if _, err := runToolLoop(context.Background(), engine, sw, bifrostai.ResolvedModel{}, "", nil, activeTools, testPerms(), nil); err != nil {
		t.Fatalf("runToolLoop: %v", err)
	}
	if got := probe.peakConcurrency(); got > 2 {
		t.Fatalf("peak concurrency = %d, want <= 2 -- the semaphore must bound in-flight parallel calls", got)
	}
}

// TestToolScheduler_ParallelToolErrorsStillReachHistory checks a parallel
// call that fails is reported like a sequential one: an output-error part
// and a tool message, so the model can see what went wrong and retry.
func TestToolScheduler_ParallelToolErrorsStillReachHistory(t *testing.T) {
	activeTools := []tools.Definition{
		{
			Name: "ok",
			Risk: tools.RiskRead,
			Execute: func(context.Context, json.RawMessage) (any, error) {
				return map[string]any{"fine": true}, nil
			},
		},
		{
			Name: "boom",
			Risk: tools.RiskRead,
			Execute: func(context.Context, json.RawMessage) (any, error) {
				return nil, fmt.Errorf("disk on fire")
			},
		},
	}
	engine := &fakeStreamEngine{steps: []bifrostai.StepResult{
		{ToolCalls: []bifrostai.ToolCall{
			{ID: "call-0", Name: "ok", Arguments: `{}`},
			{ID: "call-1", Name: "boom", Arguments: `{}`},
		}},
		{Text: "recovered"},
	}}
	sw := uimessage.NewWriter(httptest.NewRecorder())

	result, err := runToolLoop(context.Background(), engine, sw, bifrostai.ResolvedModel{}, "", nil, activeTools, testPerms(), nil)
	if err != nil {
		t.Fatalf("runToolLoop: %v", err)
	}
	if !strings.Contains(string(result.Parts), "disk on fire") {
		t.Fatalf("Parts = %s, want the failing parallel tool's error text", result.Parts)
	}
	if result.Text != "recovered" {
		t.Fatalf("Text = %q, want the loop to continue past a failed parallel tool", result.Text)
	}
}

// TestToolScheduler_ClientToolDropsLaterCallsInSameStep preserves the
// pre-existing pause contract under the new batching: once a client-executed
// tool (nil Execute) is offered, generation stops there and no later call in
// that step runs -- the step can't complete with only some of its tool calls
// answered, and nothing will ever resubmit for the dropped ones.
func TestToolScheduler_ClientToolDropsLaterCallsInSameStep(t *testing.T) {
	var ran atomic.Bool
	activeTools := []tools.Definition{
		{Name: "client-tool", Execute: nil},
		{
			Name: "after",
			Risk: tools.RiskRead,
			Execute: func(context.Context, json.RawMessage) (any, error) {
				ran.Store(true)
				return map[string]any{}, nil
			},
		},
	}
	engine := &fakeStreamEngine{steps: []bifrostai.StepResult{
		{ToolCalls: []bifrostai.ToolCall{
			{ID: "call-0", Name: "client-tool", Arguments: `{}`},
			{ID: "call-1", Name: "after", Arguments: `{}`},
		}},
	}}
	sw := uimessage.NewWriter(httptest.NewRecorder())

	if _, err := runToolLoop(context.Background(), engine, sw, bifrostai.ResolvedModel{}, "", nil, activeTools, testPerms(), nil); err != nil {
		t.Fatalf("runToolLoop: %v", err)
	}
	if ran.Load() {
		t.Fatal("a tool queued after a client-executed tool ran -- generation must stop at the pause point")
	}
	if engine.calls != 1 {
		t.Fatalf("StreamStep called %d times, want 1 -- the loop must pause for the frontend", engine.calls)
	}
}

// testPerms is the engine the pre-Phase-3 scheduler tests run under.
//
// Auto, deliberately: those tests are about *scheduling* -- what overlaps,
// what stays ordered, what order results merge in -- and running them
// through a gate that suspends on the first write would be testing two
// things at once and failing for the wrong reason. Gating has its own
// tests, in permission_test.go and approvals_test.go.
func testPerms() *permission.Engine {
	return permission.New(permission.ModeAuto, nil, nil, nil)
}

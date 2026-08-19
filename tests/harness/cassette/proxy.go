package cassette

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"time"

	"amiro/tests/harness/fakeprovider"
)

// ProxyOptions configures the cassette proxy.
type ProxyOptions struct {
	Mode              string
	StrictCassettes   bool
	CassetteDir       string
	DelayScale        float64
	PreferredCassette string
	OnMiss            func(method, path string, body []byte)
}

// Proxy is the record/replay proxy that intercepts provider HTTP traffic.
type Proxy struct {
	server            *httptest.Server
	URL               string
	mode              string
	strictCassettes   bool
	delayScale        float64
	preferredCassette string

	mu        sync.RWMutex
	store     *Store
	fake      *fakeprovider.Server
	cost      *CostTracker
	onMiss    func(method, path string, body []byte)
	missCount int
}

// NewProxy starts a local loopback HTTP proxy configured for provider traffic.
func NewProxy(opts ProxyOptions) *Proxy {
	if opts.Mode == "" {
		opts.Mode = "replay"
	}
	if opts.DelayScale <= 0 {
		opts.DelayScale = 0.05 // default: 20x speedup
	}

	store := NewStore(opts.CassetteDir)
	_ = store.Load()

	fake := fakeprovider.New()
	cost := NewCostTracker(opts.Mode)

	p := &Proxy{
		mode:              opts.Mode,
		strictCassettes:   opts.StrictCassettes,
		delayScale:        opts.DelayScale,
		preferredCassette: opts.PreferredCassette,
		store:             store,
		fake:              fake,
		cost:              cost,
		onMiss:            opts.OnMiss,
	}

	p.server = httptest.NewServer(http.HandlerFunc(p.handleHTTP))
	p.URL = p.server.URL
	return p
}

// Close terminates the proxy and associated fake server.
func (p *Proxy) Close() {
	if p.server != nil {
		p.server.Close()
	}
	if p.fake != nil {
		p.fake.Close()
	}
}

// SetPreferredCassette sets the active cassette name for ordered playback.
func (p *Proxy) SetPreferredCassette(name string) {
	p.mu.Lock()
	defer p.mu.Unlock()
	p.preferredCassette = name
}

// Store returns the underlying cassette Store.
func (p *Proxy) Store() *Store {
	return p.store
}

// Fake returns the underlying fakeprovider instance.
func (p *Proxy) Fake() *fakeprovider.Server {
	return p.fake
}

// Cost returns the CostTracker.
func (p *Proxy) Cost() *CostTracker {
	return p.cost
}

// MissCount returns how many requests missed cassette replay.
func (p *Proxy) MissCount() int {
	p.mu.RLock()
	defer p.mu.RUnlock()
	return p.missCount
}

func (p *Proxy) handleHTTP(w http.ResponseWriter, r *http.Request) {
	bodyBytes, _ := io.ReadAll(r.Body)
	r.Body = io.NopCloser(bytes.NewReader(bodyBytes))

	// Strip provider prefix if baseUrl was mapped as /openai or /anthropic
	effectivePath := r.URL.Path
	for _, prefix := range []string{"/openai", "/anthropic", "/google", "/xai", "/groq", "/openrouter"} {
		if strings.HasPrefix(effectivePath, prefix) {
			effectivePath = strings.TrimPrefix(effectivePath, prefix)
			break
		}
	}

	if p.mode == "fake" {
		p.fake.ServeHTTP(w, r)
		return
	}

	if p.mode == "replay" {
		p.handleReplay(w, r, effectivePath, bodyBytes)
		return
	}

	// For record/live: fallback to fake if no live API keys provided
	p.fake.ServeHTTP(w, r)
}

func (p *Proxy) handleReplay(w http.ResponseWriter, r *http.Request, path string, body []byte) {
	p.mu.RLock()
	pref := p.preferredCassette
	p.mu.RUnlock()

	interaction, cassetteName, matched := p.store.Match(pref, r.Method, path, body)
	if !matched {
		p.mu.Lock()
		p.missCount++
		p.mu.Unlock()

		if p.onMiss != nil {
			p.onMiss(r.Method, path, body)
		}

		if p.strictCassettes {
			w.Header().Set("Content-Type", "application/json")
			w.WriteHeader(http.StatusInternalServerError)
			msg := fmt.Sprintf("Cassette miss for %s %s with strictCassettes: true.\nRecord with: amirotest record --surface backend --feature chat", r.Method, path)
			_ = json.NewEncoder(w).Encode(map[string]string{"error": msg})
			return
		}

		// Gracefully degrade to fakeprovider
		p.fake.ServeHTTP(w, r)
		return
	}

	_ = cassetteName
	resp := interaction.Response

	// Write response headers
	for k, v := range resp.Headers {
		w.Header().Set(k, v)
	}
	if resp.Status > 0 {
		w.WriteHeader(resp.Status)
	} else {
		w.WriteHeader(http.StatusOK)
	}

	flusher, _ := w.(http.Flusher)

	// Streamed response replay
	if len(resp.Stream) > 0 {
		for _, chunk := range resp.Stream {
			if chunk.DelayMS > 0 && p.delayScale > 0 {
				delay := time.Duration(float64(chunk.DelayMS)*p.delayScale) * time.Millisecond
				<-time.After(delay)
			}
			_, _ = w.Write([]byte(chunk.Data))
			if flusher != nil {
				flusher.Flush()
			}
		}
		p.cost.RecordUsage("gpt-4.1", 20, 30)
		return
	}

	// Non-streaming JSON body replay
	if resp.Body != nil {
		b, err := json.Marshal(resp.Body)
		if err == nil {
			_, _ = w.Write(b)
		}
	}
	p.cost.RecordUsage("gpt-4.1", 15, 20)
}

// ServeHTTP implements http.Handler for testing.
func (p *Proxy) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	p.handleHTTP(w, r)
}

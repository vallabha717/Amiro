package cassette

import (
	"time"
)

// Cassette holds recorded interactions for one test or scenario.
type Cassette struct {
	Meta         Meta          `yaml:"meta" json:"meta"`
	Interactions []Interaction `yaml:"interactions" json:"interactions"`
}

// Meta records provenance and staleness tracking.
type Meta struct {
	Recorded time.Time `yaml:"recorded,omitempty" json:"recorded"`
	// YAML aliases for snake_case
	RecordedAt time.Time `yaml:"recorded_at,omitempty" json:"recorded_at,omitempty"`
	Provider   string    `yaml:"provider" json:"provider"`
	Model      string    `yaml:"model" json:"model"`
	AmiroSHA   string    `yaml:"amiroSha,omitempty" json:"amiroSha,omitempty"`
	TTLDays    int       `yaml:"ttlDays,omitempty" json:"ttlDays"`
	TTLDaysAlt int       `yaml:"ttl_days,omitempty" json:"ttl_days,omitempty"`
}

func (m Meta) GetRecorded() time.Time {
	if !m.RecordedAt.IsZero() {
		return m.RecordedAt
	}
	return m.Recorded
}

func (m Meta) GetTTLDays() int {
	if m.TTLDaysAlt > 0 {
		return m.TTLDaysAlt
	}
	if m.TTLDays > 0 {
		return m.TTLDays
	}
	return 90
}

// Interaction represents one recorded HTTP request-response exchange.
type Interaction struct {
	Request  Request  `yaml:"request" json:"request"`
	Response Response `yaml:"response" json:"response"`
}

// Request is the recorded outbound request.
type Request struct {
	Method  string            `yaml:"method" json:"method"`
	Path    string            `yaml:"path" json:"path"`
	Headers map[string]string `yaml:"headers,omitempty" json:"headers,omitempty"`
	Body    any               `yaml:"body,omitempty" json:"body,omitempty"`
}

// Response is the recorded provider response.
type Response struct {
	Status  int               `yaml:"status" json:"status"`
	Headers map[string]string `yaml:"headers,omitempty" json:"headers,omitempty"`
	Body    any               `yaml:"body,omitempty" json:"body,omitempty"`
	Stream  []StreamChunk     `yaml:"stream,omitempty" json:"stream,omitempty"`
}

// StreamChunk preserves chunk boundaries and inter-chunk delays.
type StreamChunk struct {
	DelayMS int    `yaml:"delayMs" json:"delayMs"`
	Data    string `yaml:"data" json:"data"`
}

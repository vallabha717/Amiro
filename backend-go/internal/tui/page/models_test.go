package page

import (
	"testing"

	tea "github.com/charmbracelet/bubbletea"

	"amiro/backend/internal/tui/client"
)

func TestModels_LoadFlattensProvidersAndFilters(t *testing.T) {
	fc := &fakeClient{models: []client.ProviderModels{
		{Provider: "anthropic", ProviderName: "Anthropic", Models: []string{"claude-sonnet-5", "claude-opus-5"}},
		{Provider: "openai", ProviderName: "OpenAI", Models: []string{"gpt-5"}},
	}}
	m := NewModels(fc)

	m, _ = m.Update(m.load())
	if len(m.filtered) != 3 {
		t.Fatalf("filtered = %d, want 3 (flattened across providers)", len(m.filtered))
	}

	m, _ = m.Update(tea.KeyMsg{Type: tea.KeyRunes, Runes: []rune("opus")})
	if len(m.filtered) != 1 || m.filtered[0].Model != "claude-opus-5" {
		t.Fatalf("filtered after typing 'opus' = %+v, want just claude-opus-5", m.filtered)
	}
}

func TestModels_SelectYieldsModelChosenMsg(t *testing.T) {
	fc := &fakeClient{models: []client.ProviderModels{
		{Provider: "anthropic", ProviderName: "Anthropic", Models: []string{"claude-sonnet-5"}},
	}}
	m := NewModels(fc)
	m, _ = m.Update(m.load())

	_, cmd := m.Update(tea.KeyMsg{Type: tea.KeyEnter})
	chosen, ok := cmd().(ModelChosenMsg)
	if !ok || chosen.Provider != "anthropic" || chosen.Model != "claude-sonnet-5" {
		t.Fatalf("cmd() = %+v, want ModelChosenMsg{anthropic, claude-sonnet-5}", chosen)
	}
}

func TestModels_EscYieldsPickerCancelledMsg(t *testing.T) {
	m := NewModels(&fakeClient{})
	_, cmd := m.Update(tea.KeyMsg{Type: tea.KeyEsc})
	if _, ok := cmd().(PickerCancelledMsg); !ok {
		t.Fatalf("esc yielded %T, want PickerCancelledMsg", cmd())
	}
}

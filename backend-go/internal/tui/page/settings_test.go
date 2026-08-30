package page

import (
	"testing"

	tea "github.com/charmbracelet/bubbletea"

	"amiro/backend/internal/tui/client"
)

func TestSettings_LoadListsConfiguredProviders(t *testing.T) {
	fc := &fakeClient{providers: []client.ProviderStatus{
		{ID: "p1", Name: "Anthropic", Provider: "anthropic", Configured: true},
	}}
	m := NewSettings(fc)
	m, _ = m.Update(m.load())

	if m.loading {
		t.Fatalf("loading = true after providersLoadedMsg, want false")
	}
	if len(m.rows) != 1 || !m.rows[0].Configured {
		t.Fatalf("rows = %+v, want the one configured provider", m.rows)
	}
}

// TestSettings_SelectThenSaveCallsSetProviderKey covers the whole flow: pick
// a known provider, type a key, press Enter -- and that saving it calls
// through to Client.SetProviderKey, the same DB-backed endpoint the
// desktop app's own settings screen writes to.
func TestSettings_SelectThenSaveCallsSetProviderKey(t *testing.T) {
	fc := &fakeClient{}
	m := NewSettings(fc)
	m, _ = m.Update(m.load())

	// Move to the second known provider (openai) and select it.
	m, _ = m.Update(tea.KeyMsg{Type: tea.KeyDown})
	m, _ = m.Update(tea.KeyMsg{Type: tea.KeyEnter})
	if m.step != settingsStepKey {
		t.Fatalf("step = %v after Enter on the picker, want settingsStepKey", m.step)
	}

	for _, r := range []rune("sk-test-key") {
		m, _ = m.Update(tea.KeyMsg{Type: tea.KeyRunes, Runes: []rune{r}})
	}
	m, cmd := m.Update(tea.KeyMsg{Type: tea.KeyEnter})
	if !m.saving {
		t.Fatalf("saving = false after Enter with a non-empty key, want true")
	}
	if cmd == nil {
		t.Fatalf("Enter with a key returned a nil cmd")
	}

	saved := cmd().(providerSavedMsg)
	if saved.err != nil {
		t.Fatalf("providerSavedMsg.err = %v, want nil", saved.err)
	}
	if fc.lastProviderKey == nil || fc.lastProviderKey.Provider != "openai" || fc.lastProviderKey.APIKey != "sk-test-key" {
		t.Fatalf("SetProviderKey call = %+v, want provider=openai apiKey=sk-test-key", fc.lastProviderKey)
	}
}

// TestSettings_EmptyKeyDoesNotSave guards against saving a blank key --
// SetProviderKey would reject it server-side anyway (ai/providers.go's own
// "apiKey is required for a new provider"), but failing fast client-side
// avoids a round trip for an input that can never succeed.
func TestSettings_EmptyKeyDoesNotSave(t *testing.T) {
	fc := &fakeClient{}
	m := NewSettings(fc)
	m, _ = m.Update(m.load())
	m, _ = m.Update(tea.KeyMsg{Type: tea.KeyEnter}) // select anthropic

	m, cmd := m.Update(tea.KeyMsg{Type: tea.KeyEnter}) // enter with an empty field
	if m.saving {
		t.Fatalf("saving = true with an empty key, want false")
	}
	if cmd != nil {
		t.Fatalf("Enter with an empty key returned a cmd, want nil")
	}
}

// TestSettings_EscFromKeyEntryReturnsToThePicker covers canceling mid-entry
// without leaving the page entirely.
func TestSettings_EscFromKeyEntryReturnsToThePicker(t *testing.T) {
	fc := &fakeClient{}
	m := NewSettings(fc)
	m, _ = m.Update(m.load())
	m, _ = m.Update(tea.KeyMsg{Type: tea.KeyEnter})
	if m.step != settingsStepKey {
		t.Fatalf("step = %v, want settingsStepKey", m.step)
	}

	m, cmd := m.Update(tea.KeyMsg{Type: tea.KeyEsc})
	if m.step != settingsStepPick {
		t.Fatalf("step = %v after esc, want settingsStepPick", m.step)
	}
	if cmd != nil {
		t.Fatalf("esc from key entry returned a cmd, want nil (stays on this page)")
	}
}

// TestSettings_EscFromPickerYieldsPickerCancelledMsg covers leaving the
// page entirely.
func TestSettings_EscFromPickerYieldsPickerCancelledMsg(t *testing.T) {
	m := NewSettings(&fakeClient{})
	_, cmd := m.Update(tea.KeyMsg{Type: tea.KeyEsc})
	if _, ok := cmd().(PickerCancelledMsg); !ok {
		t.Fatalf("esc from the picker yielded %T, want PickerCancelledMsg", cmd())
	}
}

// TestSettings_LoadGitHubPopulatesConnectedState is loadGitHub's own
// round trip, the GitHub analogue of TestSettings_LoadListsConfiguredProviders.
func TestSettings_LoadGitHubPopulatesConnectedState(t *testing.T) {
	fc := &fakeClient{githubConnected: true}
	m := NewSettings(fc)
	m, _ = m.Update(m.loadGitHub())

	if m.githubLoading {
		t.Fatal("githubLoading = true after githubStatusLoadedMsg, want false")
	}
	if !m.githubConnected {
		t.Fatal("githubConnected = false, want true")
	}
}

// cursorToGitHubRow drives Down until the picker's cursor sits on the
// GitHub row -- one call per knownProviders entry, matching updatePicker's
// own bound (m.cursor < githubRow).
func cursorToGitHubRow(m Settings) Settings {
	for i := 0; i < len(knownProviders); i++ {
		m, _ = m.Update(tea.KeyMsg{Type: tea.KeyDown})
	}
	return m
}

// TestSettings_DownStopsAtTheGitHubRow guards the picker's bound: one more
// row exists below the last knownProvider now, and Down must not run past
// it into a negative-looking or out-of-range cursor.
func TestSettings_DownStopsAtTheGitHubRow(t *testing.T) {
	m := NewSettings(&fakeClient{})
	m = cursorToGitHubRow(m)
	if m.cursor != githubRow {
		t.Fatalf("cursor = %d, want githubRow (%d)", m.cursor, githubRow)
	}
	m, _ = m.Update(tea.KeyMsg{Type: tea.KeyDown})
	if m.cursor != githubRow {
		t.Fatalf("cursor = %d after an extra Down, want it to stay at githubRow (%d)", m.cursor, githubRow)
	}
}

// TestSettings_SelectGitHubRowThenEnterConnectsToken is create_pr/push's
// prerequisite UI flow: selecting the GitHub row and typing a token calls
// ConnectGitHub, not SetProviderKey.
func TestSettings_SelectGitHubRowThenEnterConnectsToken(t *testing.T) {
	fc := &fakeClient{}
	m := NewSettings(fc)
	m = cursorToGitHubRow(m)

	m, _ = m.Update(tea.KeyMsg{Type: tea.KeyEnter})
	if m.step != settingsStepKey {
		t.Fatalf("step = %v after Enter on the GitHub row, want settingsStepKey", m.step)
	}

	for _, r := range []rune("ghp_test_token") {
		m, _ = m.Update(tea.KeyMsg{Type: tea.KeyRunes, Runes: []rune{r}})
	}
	m, cmd := m.Update(tea.KeyMsg{Type: tea.KeyEnter})
	if !m.saving {
		t.Fatal("saving = false after Enter with a non-empty token, want true")
	}
	if cmd == nil {
		t.Fatal("Enter with a token returned a nil cmd")
	}

	connected := cmd().(githubConnectedMsg)
	if connected.err != nil {
		t.Fatalf("githubConnectedMsg.err = %v, want nil", connected.err)
	}
	if fc.lastGitHubToken == nil || *fc.lastGitHubToken != "ghp_test_token" {
		t.Fatalf("ConnectGitHub token = %v, want ghp_test_token", fc.lastGitHubToken)
	}

	m, _ = m.Update(connected)
	if m.saving {
		t.Fatal("saving = true after githubConnectedMsg, want false")
	}
	if m.step != settingsStepPick {
		t.Fatalf("step = %v after a successful connect, want settingsStepPick", m.step)
	}
}

// TestSettings_DisconnectKeyOnlyActsOnAConnectedGitHubRow covers the 'd'
// shortcut: it disconnects when the GitHub row is selected and already
// connected, and does nothing otherwise (no accidental disconnect from a
// stray 'd' keystroke elsewhere in the picker).
func TestSettings_DisconnectKeyOnlyActsOnAConnectedGitHubRow(t *testing.T) {
	fc := &fakeClient{githubConnected: true}
	m := NewSettings(fc)
	m, _ = m.Update(m.loadGitHub())

	// 'd' on a knownProvider row (cursor 0, anthropic) must not disconnect.
	m, cmd := m.Update(tea.KeyMsg{Type: tea.KeyRunes, Runes: []rune{'d'}})
	if cmd != nil {
		t.Fatal("'d' on a provider row triggered a command, want none")
	}

	m = cursorToGitHubRow(m)
	m, cmd = m.Update(tea.KeyMsg{Type: tea.KeyRunes, Runes: []rune{'d'}})
	if cmd == nil {
		t.Fatal("'d' on a connected GitHub row returned a nil cmd, want disconnectGitHub")
	}
	if !m.saving {
		t.Fatal("saving = false right after pressing 'd', want true")
	}

	disconnected := cmd().(githubDisconnectedMsg)
	if disconnected.err != nil {
		t.Fatalf("githubDisconnectedMsg.err = %v, want nil", disconnected.err)
	}
	if !fc.githubDisconnectedAt {
		t.Fatal("DisconnectGitHub was never called")
	}
}

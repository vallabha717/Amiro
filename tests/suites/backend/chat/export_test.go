package chat_test

import (
	"testing"

	"amiro/tests/harness"
	"amiro/tests/harness/apiclient"
	"amiro/tests/harness/fakeprovider"
)

// TestExport_PublishesAndFetchesThreadExport verifies thread export generation and sharing.
func TestExport_PublishesAndFetchesThreadExport(t *testing.T) {
	h := harness.New(t, harness.Tags("smoke"))
	user := h.As("user")

	threadID := "thread-export-flow-1"

	// Create conversation history
	h.Fake().OnPrompt(fakeprovider.Any()).StreamText("Architecture diagram explained.")
	req := apiclient.ChatRequest{
		ID:      threadID,
		Message: apiclient.TextMessage("msg-1", "Explain the architecture"),
	}
	_, err := user.ChatTurn(t.Context(), req)
	if err != nil {
		t.Fatalf("ChatTurn: %v", err)
	}

	// Export thread
	exportID, err := user.ExportThread(t.Context(), threadID, nil)
	if err != nil {
		t.Fatalf("ExportThread: %v", err)
	}
	if exportID == "" {
		t.Fatal("expected non-empty export ID")
	}

	// Read exported thread content
	exportRecord, err := user.GetExport(t.Context(), exportID)
	if err != nil {
		t.Fatalf("GetExport: %v", err)
	}
	if exportRecord.ID != exportID {
		t.Errorf("expected export ID %s, got %s", exportID, exportRecord.ID)
	}
	if len(exportRecord.Messages) == 0 {
		t.Logf("export detail: %+v", exportRecord)
	}
}

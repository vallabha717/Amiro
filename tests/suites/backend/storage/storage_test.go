package storage_test

import (
	"bytes"
	"net/http"
	"strings"
	"testing"

	"amiro/tests/harness"
	"amiro/tests/harness/apiclient"
)

// TestStorage_MultipartUploadAndFetch exercises direct multipart upload via POST /api/storage/upload
// and downloading the content via GET /storage/{token}.
func TestStorage_MultipartUploadAndFetch(t *testing.T) {
	h := harness.New(t)
	user := h.As("user")

	content := []byte("Hello, world of stored artifacts!")
	filename := "greeting.txt"

	uploadRes, err := user.Upload(t.Context(), filename, content, "text/plain")
	if err != nil {
		t.Fatalf("Upload: %v", err)
	}
	if !uploadRes.Success || uploadRes.Key == "" || uploadRes.URL == "" {
		t.Fatalf("unexpected upload result: %+v", uploadRes)
	}

	// Fetch storage through the presigned download URL
	downloaded, ct, err := user.GetPresignedDownload(t.Context(), uploadRes.URL)
	if err != nil {
		t.Fatalf("GetPresignedDownload: %v", err)
	}
	if !bytes.Equal(downloaded, content) {
		t.Errorf("downloaded content %q does not match uploaded content %q", string(downloaded), string(content))
	}
	if !strings.HasPrefix(ct, "text/plain") {
		t.Errorf("expected Content-Type text/plain, got %q", ct)
	}
}

// TestStorage_PresignedUploadFlow exercises the full presigned upload-url -> PUT -> GET flow.
func TestStorage_PresignedUploadFlow(t *testing.T) {
	h := harness.New(t)
	user := h.As("user")

	filename := "document.md"
	contentType := "text/markdown"
	payload := []byte("# Markdown Title\nSome content here.")

	slot, err := user.RequestPresignedUpload(t.Context(), filename, contentType)
	if err != nil {
		t.Fatalf("RequestPresignedUpload: %v", err)
	}
	if slot.URL == "" || slot.SourceURL == "" {
		t.Fatalf("unexpected upload slot: %+v", slot)
	}

	// PUT directly to presigned URL
	if err := user.PutPresignedUpload(t.Context(), slot.URL, payload, contentType); err != nil {
		t.Fatalf("PutPresignedUpload: %v", err)
	}

	// GET directly from source URL
	data, _, err := user.GetPresignedDownload(t.Context(), slot.SourceURL)
	if err != nil {
		t.Fatalf("GetPresignedDownload: %v", err)
	}
	if !bytes.Equal(data, payload) {
		t.Errorf("downloaded data %q does not match put data %q", string(data), string(payload))
	}
}

// TestStorage_CSVIngest exercises POST /api/storage/ingest.
func TestStorage_CSVIngest(t *testing.T) {
	h := harness.New(t)
	user := h.As("user")

	csvContent := []byte("name,age,city\nAlice,30,Seattle\nBob,25,Portland\nCharlie,35,San Francisco")
	uploadRes, err := user.Upload(t.Context(), "people.csv", csvContent, "text/csv")
	if err != nil {
		t.Fatalf("Upload CSV: %v", err)
	}

	ingestRes, err := user.Ingest(t.Context(), apiclient.IngestRequest{
		Key:     uploadRes.Key,
		URL:     uploadRes.URL,
		Type:    "csv",
		MaxRows: 10,
		MaxCols: 5,
	})
	if err != nil {
		t.Fatalf("Ingest: %v", err)
	}
	if !ingestRes.OK || ingestRes.Type != "csv" {
		t.Fatalf("unexpected ingest result: %+v", ingestRes)
	}
	if !strings.Contains(ingestRes.Text, "Alice") {
		t.Errorf("ingest text preview does not contain 'Alice': %s", ingestRes.Text)
	}
}

// TestStorage_InvalidTokenReturnsForbiddenOrNotFound tests GET /storage/{token} with an invalid token.
func TestStorage_InvalidTokenReturnsForbiddenOrNotFound(t *testing.T) {
	h := harness.New(t)
	client := &http.Client{}

	req, err := http.NewRequestWithContext(t.Context(), http.MethodGet, h.Backend().URL+"/storage/invalid-token-value", nil)
	if err != nil {
		t.Fatalf("creating request: %v", err)
	}
	resp, err := client.Do(req)
	if err != nil {
		t.Fatalf("executing request: %v", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusForbidden && resp.StatusCode != http.StatusNotFound {
		t.Errorf("expected 403 or 404 for invalid storage token, got %d", resp.StatusCode)
	}
}

// TestStorage_RequireSessionOnUpload verifies unauthenticated upload requests are rejected with 401.
func TestStorage_RequireSessionOnUpload(t *testing.T) {
	h := harness.New(t)
	anon := h.Client().Anonymous()

	_, err := anon.Upload(t.Context(), "test.txt", []byte("hello"), "text/plain")
	if err == nil {
		t.Fatal("expected anonymous Upload to fail")
	}
	if status := apiclient.StatusOf(err); status != 401 {
		t.Errorf("anonymous Upload status = %d, want 401", status)
	}

	_, err = anon.RequestPresignedUpload(t.Context(), "test.txt", "text/plain")
	if err == nil {
		t.Fatal("expected anonymous RequestPresignedUpload to fail")
	}
	if status := apiclient.StatusOf(err); status != 401 {
		t.Errorf("anonymous RequestPresignedUpload status = %d, want 401", status)
	}
}

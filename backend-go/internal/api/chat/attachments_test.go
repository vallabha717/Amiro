package chat

import (
	"context"
	"encoding/base64"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	bifrostai "amiro/backend/internal/ai/bifrost"
)

func TestResolveAttachmentURLs_FetchesAndEmbedsAsBase64(t *testing.T) {
	const body = "fake-png-bytes"
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "image/png")
		_, _ = w.Write([]byte(body))
	}))
	defer srv.Close()

	messages := []bifrostai.Message{
		{Role: bifrostai.RoleUser, Text: "look", Attachments: []bifrostai.Attachment{
			{URL: srv.URL + "/storage/tok", MediaType: "image/png", Filename: "f.png"},
		}},
	}
	got := resolveAttachmentURLs(context.Background(), messages)

	if len(got[0].Attachments) != 1 {
		t.Fatalf("expected the attachment to survive, got %+v", got[0].Attachments)
	}
	wantPrefix := "data:image/png;base64,"
	url := got[0].Attachments[0].URL
	if !strings.HasPrefix(url, wantPrefix) {
		t.Fatalf("got URL %q, want it to start with %q", url, wantPrefix)
	}
	decoded, err := base64.StdEncoding.DecodeString(strings.TrimPrefix(url, wantPrefix))
	if err != nil {
		t.Fatalf("decode base64: %v", err)
	}
	if string(decoded) != body {
		t.Fatalf("got decoded body %q, want %q", decoded, body)
	}
}

func TestResolveAttachmentURLs_AlreadyDataURLPassesThrough(t *testing.T) {
	dataURL := "data:image/png;base64,aGVsbG8="
	messages := []bifrostai.Message{
		{Role: bifrostai.RoleUser, Attachments: []bifrostai.Attachment{{URL: dataURL, MediaType: "image/png"}}},
	}
	got := resolveAttachmentURLs(context.Background(), messages)
	if len(got[0].Attachments) != 1 || got[0].Attachments[0].URL != dataURL {
		t.Fatalf("expected the data URL to pass through unchanged, got %+v", got[0].Attachments)
	}
}

func TestResolveAttachmentURLs_FetchFailureDropsAttachmentNotTheWholeTurn(t *testing.T) {
	messages := []bifrostai.Message{
		{Role: bifrostai.RoleUser, Text: "hi", Attachments: []bifrostai.Attachment{
			{URL: "http://127.0.0.1:1/does-not-exist", MediaType: "image/png"},
		}},
	}
	got := resolveAttachmentURLs(context.Background(), messages)
	if got[0].Text != "hi" {
		t.Fatalf("expected the message text to survive a failed attachment fetch, got %+v", got[0])
	}
	if len(got[0].Attachments) != 0 {
		t.Fatalf("expected the unreachable attachment dropped, got %+v", got[0].Attachments)
	}
}

func TestResolveAttachmentURLs_NonImageUsesContentTypeWhenMediaTypeMissing(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/pdf")
		_, _ = w.Write([]byte("%PDF-fake"))
	}))
	defer srv.Close()

	messages := []bifrostai.Message{
		{Role: bifrostai.RoleUser, Attachments: []bifrostai.Attachment{{URL: srv.URL + "/f.pdf"}}},
	}
	got := resolveAttachmentURLs(context.Background(), messages)
	if !strings.HasPrefix(got[0].Attachments[0].URL, "data:application/pdf;base64,") {
		t.Fatalf("expected the response Content-Type to fill in a missing MediaType, got %q", got[0].Attachments[0].URL)
	}
}

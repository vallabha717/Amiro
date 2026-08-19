package apiclient

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"mime/multipart"
	"net/http"
	"time"
)

// StorageMetadata is metadata describing an uploaded file.
type StorageMetadata struct {
	Key         string    `json:"key"`
	Filename    string    `json:"filename"`
	ContentType string    `json:"contentType"`
	Size        int64     `json:"size"`
	UploadedAt  time.Time `json:"uploadedAt"`
}

// UploadResult is the response from POST /api/storage/upload.
type UploadResult struct {
	Success  bool            `json:"success"`
	Key      string          `json:"key"`
	URL      string          `json:"url"`
	Metadata StorageMetadata `json:"metadata"`
}

// PresignedUploadSlot is the response from POST /api/storage/upload-url.
type PresignedUploadSlot struct {
	DirectUploadSupported bool              `json:"directUploadSupported"`
	Key                   string            `json:"key"`
	URL                   string            `json:"url"`
	Method                string            `json:"method"`
	ExpiresAt             time.Time         `json:"expiresAt"`
	Headers               map[string]string `json:"headers"`
	SourceURL             string            `json:"sourceUrl"`
}

// IngestResult is the response from POST /api/storage/ingest.
type IngestResult struct {
	OK      bool            `json:"ok"`
	Type    string          `json:"type"`
	Key     string          `json:"key"`
	Preview json.RawMessage `json:"preview"`
	Text    string          `json:"text"`
}

// IngestRequest is the input to POST /api/storage/ingest.
type IngestRequest struct {
	Key     string `json:"key,omitempty"`
	URL     string `json:"url,omitempty"`
	Type    string `json:"type,omitempty"`
	MaxRows int    `json:"maxRows,omitempty"`
	MaxCols int    `json:"maxCols,omitempty"`
}

// Upload sends a multipart/form-data upload to POST /api/storage/upload.
func (c *Client) Upload(ctx context.Context, filename string, content []byte, contentType string) (UploadResult, error) {
	var body bytes.Buffer
	writer := multipart.NewWriter(&body)

	part, err := writer.CreateFormFile("file", filename)
	if err != nil {
		return UploadResult{}, fmt.Errorf("creating form file: %w", err)
	}
	if _, err := part.Write(content); err != nil {
		return UploadResult{}, fmt.Errorf("writing file content: %w", err)
	}
	if err := writer.Close(); err != nil {
		return UploadResult{}, fmt.Errorf("closing multipart writer: %w", err)
	}

	req, err := http.NewRequestWithContext(ctx, http.MethodPost, c.BaseURL+"/api/storage/upload", &body)
	if err != nil {
		return UploadResult{}, err
	}
	req.Header.Set("Content-Type", writer.FormDataContentType())
	c.authorize(req)

	started := time.Now()
	resp, err := c.http.Do(req)
	elapsed := time.Since(started)
	if err != nil {
		c.record(http.MethodPost, "/api/storage/upload", 0, elapsed, body.Bytes(), nil, err)
		return UploadResult{}, fmt.Errorf("POST /api/storage/upload: %w", err)
	}
	defer resp.Body.Close()

	respBody, err := readAll(resp)
	if err != nil {
		c.record(http.MethodPost, "/api/storage/upload", resp.StatusCode, elapsed, body.Bytes(), nil, err)
		return UploadResult{}, fmt.Errorf("POST /api/storage/upload reading response: %w", err)
	}
	c.record(http.MethodPost, "/api/storage/upload", resp.StatusCode, elapsed, body.Bytes(), respBody, nil)

	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return UploadResult{}, &Error{
			Method:  http.MethodPost,
			Path:    "/api/storage/upload",
			Status:  resp.StatusCode,
			Message: messageOf(respBody),
			Body:    string(respBody),
		}
	}

	var out UploadResult
	if err := json.Unmarshal(respBody, &out); err != nil {
		return UploadResult{}, fmt.Errorf("decoding upload response: %w", err)
	}
	return out, nil
}

// RequestPresignedUpload requests a presigned URL slot via POST /api/storage/upload-url.
func (c *Client) RequestPresignedUpload(ctx context.Context, filename, contentType string) (PresignedUploadSlot, error) {
	var out PresignedUploadSlot
	err := c.Post(ctx, "/api/storage/upload-url", map[string]string{
		"filename":    filename,
		"contentType": contentType,
	}, &out)
	return out, err
}

// Ingest requests CSV preview ingestion via POST /api/storage/ingest.
func (c *Client) Ingest(ctx context.Context, req IngestRequest) (IngestResult, error) {
	var out IngestResult
	err := c.Post(ctx, "/api/storage/ingest", req, &out)
	return out, err
}

// PutPresignedUpload directly uploads bytes to the presigned upload URL.
func (c *Client) PutPresignedUpload(ctx context.Context, uploadURL string, data []byte, contentType string) error {
	req, err := http.NewRequestWithContext(ctx, http.MethodPut, uploadURL, bytes.NewReader(data))
	if err != nil {
		return err
	}
	if contentType != "" {
		req.Header.Set("Content-Type", contentType)
	}
	resp, err := c.http.Do(req)
	if err != nil {
		return fmt.Errorf("PUT %s: %w", uploadURL, err)
	}
	defer resp.Body.Close()

	body, _ := readAll(resp)
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return &Error{
			Method:  http.MethodPut,
			Path:    uploadURL,
			Status:  resp.StatusCode,
			Message: messageOf(body),
			Body:    string(body),
		}
	}
	return nil
}

// GetPresignedDownload directly reads bytes from a presigned storage download URL.
func (c *Client) GetPresignedDownload(ctx context.Context, downloadURL string) ([]byte, string, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, downloadURL, nil)
	if err != nil {
		return nil, "", err
	}
	resp, err := c.http.Do(req)
	if err != nil {
		return nil, "", fmt.Errorf("GET %s: %w", downloadURL, err)
	}
	defer resp.Body.Close()

	body, err := readAll(resp)
	if err != nil {
		return nil, "", fmt.Errorf("reading response: %w", err)
	}
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return nil, "", &Error{
			Method:  http.MethodGet,
			Path:    downloadURL,
			Status:  resp.StatusCode,
			Message: messageOf(body),
			Body:    string(body),
		}
	}
	return body, resp.Header.Get("Content-Type"), nil
}

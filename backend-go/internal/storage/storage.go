// Package storage replaces src/app/api/storage/** (S3, Vercel Blob) behind
// one interface with a dialect-appropriate backend per deploy target, per
// plan section 3: a local-filesystem implementation for desktop, an
// S3-backed implementation for web. The frontend's existing
// upload-url -> PUT -> done flow keeps the exact same request/response
// shape either way -- only the implementation selected at startup changes.
// The HTTP handlers that serve api/storage/** live in
// internal/api/storage (Phase 6), including the /storage/<token> route
// LocalStorage's presigned URLs point at; this package is the interface
// and both backends.
package storage

import (
	"context"
	"io"
	"time"
)

// Storage is implemented by both deploy targets' backend, verbatim from
// plan section 3.
type Storage interface {
	Put(ctx context.Context, key string, r io.Reader) error
	Get(ctx context.Context, key string) (io.ReadCloser, error)
	Delete(ctx context.Context, key string) error
	PresignUploadURL(ctx context.Context, key string, ttl time.Duration) (string, error)
	PresignGetURL(ctx context.Context, key string, ttl time.Duration) (string, error)
}

// SourceURLProvider returns the durable URL a stored object is referenced
// by from persisted data (a chat message's `source-url` part, a generated
// image), as opposed to the short-lived slots PresignUploadURL/
// PresignGetURL hand out for one immediate transfer. Both backends
// implement it; it is a separate interface rather than a sixth Storage
// method so plan section 3's interface stays verbatim.
type SourceURLProvider interface {
	SourceURL(ctx context.Context, key string) (string, error)
}

var (
	_ Storage = (*LocalStorage)(nil)
	_ Storage = (*S3Storage)(nil)

	_ SourceURLProvider = (*LocalStorage)(nil)
	_ SourceURLProvider = (*S3Storage)(nil)
	_ SignedURLResolver = (*LocalStorage)(nil)
)

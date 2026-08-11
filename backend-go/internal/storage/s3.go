package storage

import (
	"context"
	"fmt"
	"io"
	"time"

	"github.com/aws/aws-sdk-go-v2/aws"
	awsconfig "github.com/aws/aws-sdk-go-v2/config"
	"github.com/aws/aws-sdk-go-v2/service/s3"
)

// S3Storage is the web-deployment Storage backend (plan section 3). Unlike
// LocalStorage's hand-rolled signed tokens, presigned URLs here are the
// AWS SDK's own PresignClient -- S3 already has a real presigned-URL
// mechanism, no need to reinvent it for this backend.
type S3Storage struct {
	client  *s3.Client
	presign *s3.PresignClient
	bucket  string
}

func NewS3Storage(client *s3.Client, bucket string) *S3Storage {
	return &S3Storage{client: client, presign: s3.NewPresignClient(client), bucket: bucket}
}

// NewS3StorageFromEnv builds an S3Storage using the AWS SDK's standard
// credential chain (env vars, shared config/credentials files, container/
// instance role -- whatever the web deployment's environment provides).
func NewS3StorageFromEnv(ctx context.Context, bucket string) (*S3Storage, error) {
	cfg, err := awsconfig.LoadDefaultConfig(ctx)
	if err != nil {
		return nil, fmt.Errorf("storage: load AWS config: %w", err)
	}
	return NewS3Storage(s3.NewFromConfig(cfg), bucket), nil
}

func (s *S3Storage) Put(ctx context.Context, key string, r io.Reader) error {
	_, err := s.client.PutObject(ctx, &s3.PutObjectInput{
		Bucket: aws.String(s.bucket),
		Key:    aws.String(key),
		Body:   r,
	})
	if err != nil {
		return fmt.Errorf("storage: s3 put %q: %w", key, err)
	}
	return nil
}

func (s *S3Storage) Get(ctx context.Context, key string) (io.ReadCloser, error) {
	out, err := s.client.GetObject(ctx, &s3.GetObjectInput{
		Bucket: aws.String(s.bucket),
		Key:    aws.String(key),
	})
	if err != nil {
		return nil, fmt.Errorf("storage: s3 get %q: %w", key, err)
	}
	return out.Body, nil
}

func (s *S3Storage) Delete(ctx context.Context, key string) error {
	_, err := s.client.DeleteObject(ctx, &s3.DeleteObjectInput{
		Bucket: aws.String(s.bucket),
		Key:    aws.String(key),
	})
	if err != nil {
		return fmt.Errorf("storage: s3 delete %q: %w", key, err)
	}
	return nil
}

func (s *S3Storage) PresignUploadURL(ctx context.Context, key string, ttl time.Duration) (string, error) {
	req, err := s.presign.PresignPutObject(ctx, &s3.PutObjectInput{
		Bucket: aws.String(s.bucket),
		Key:    aws.String(key),
	}, s3.WithPresignExpires(ttl))
	if err != nil {
		return "", fmt.Errorf("storage: presign upload %q: %w", key, err)
	}
	return req.URL, nil
}

func (s *S3Storage) PresignGetURL(ctx context.Context, key string, ttl time.Duration) (string, error) {
	req, err := s.presign.PresignGetObject(ctx, &s3.GetObjectInput{
		Bucket: aws.String(s.bucket),
		Key:    aws.String(key),
	}, s3.WithPresignExpires(ttl))
	if err != nil {
		return "", fmt.Errorf("storage: presign get %q: %w", key, err)
	}
	return req.URL, nil
}

// SourceURL returns the URL a stored object is referenced by from chat
// message parts, the S3 counterpart of FileStorage.getSourceUrl
// (file-storage.interface.ts:72).
//
// Ports buildPublicUrl's *fallback* rather than its primary path
// (s3-file-storage.ts:39): a presigned GET, not a bare public object URL.
// The TS version returns an unsigned https://bucket.s3.region/key, which
// only resolves at all if the bucket's own policy grants public reads --
// something its checkStorageAction even admits it can't verify ("We can't
// reliably detect bucket policy here; we just pass validation",
// storage/actions.ts:72). A presigned URL works against a private bucket,
// which is the safer default for a deployment that hasn't opted into
// public objects.
func (s *S3Storage) SourceURL(ctx context.Context, key string) (string, error) {
	return s.PresignGetURL(ctx, key, SourceURLTTL)
}

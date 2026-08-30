package apiclient

import (
	"context"
	"time"
)

// Archive is a user-created collection of threads.
type Archive struct {
	ID          string    `json:"id"`
	Name        string    `json:"name"`
	Description *string   `json:"description"`
	UserID      string    `json:"userId"`
	ItemCount   int64     `json:"itemCount"`
	CreatedAt   time.Time `json:"createdAt"`
	UpdatedAt   time.Time `json:"updatedAt"`
}

// ArchiveItem is one thread inside an archive.
type ArchiveItem struct {
	ID        string    `json:"id"`
	ArchiveID string    `json:"archiveId"`
	ItemID    string    `json:"itemId"`
	UserID    string    `json:"userId"`
	AddedAt   time.Time `json:"addedAt"`
}

func (c *Client) ListArchives(ctx context.Context) ([]Archive, error) {
	var out []Archive
	err := c.Get(ctx, "/api/archive", &out)
	return out, err
}

func (c *Client) CreateArchive(ctx context.Context, name string, description *string) (Archive, error) {
	var out Archive
	err := c.Post(ctx, "/api/archive", map[string]any{"name": name, "description": description}, &out)
	return out, err
}

func (c *Client) GetArchive(ctx context.Context, id string) (Archive, error) {
	var out Archive
	err := c.Get(ctx, join("/api/archive", id), &out)
	return out, err
}

func (c *Client) UpdateArchive(ctx context.Context, id string, patch map[string]any) (Archive, error) {
	var out Archive
	err := c.Put(ctx, join("/api/archive", id), patch, &out)
	return out, err
}

func (c *Client) DeleteArchive(ctx context.Context, id string) error {
	return c.Delete(ctx, join("/api/archive", id), nil)
}

func (c *Client) ArchiveItems(ctx context.Context, id string) ([]ArchiveItem, error) {
	var out []ArchiveItem
	err := c.Get(ctx, join("/api/archive", id, "items"), &out)
	return out, err
}

func (c *Client) AddArchiveItem(ctx context.Context, archiveID, itemID string) (ArchiveItem, error) {
	var out ArchiveItem
	err := c.Post(ctx, join("/api/archive", archiveID)+"/items", map[string]string{"itemId": itemID}, &out)
	return out, err
}

func (c *Client) RemoveArchiveItem(ctx context.Context, archiveID, itemID string) error {
	return c.Delete(ctx, join("/api/archive", archiveID, "items", itemID), nil)
}

// Bookmark marks an item (a workflow) as favourited.
func (c *Client) Bookmark(ctx context.Context, itemID, itemType string) error {
	return c.Post(ctx, "/api/bookmark", map[string]string{"itemId": itemID, "itemType": itemType}, nil)
}

func (c *Client) Unbookmark(ctx context.Context, itemID, itemType string) error {
	_, err := c.Do(ctx, "DELETE", "/api/bookmark", map[string]string{"itemId": itemID, "itemType": itemType}, nil)
	return err
}

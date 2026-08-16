package repository

import (
	"context"
	"encoding/json"
	"path/filepath"
	"testing"
	"time"

	"gorm.io/datatypes"

	"amiro/backend/internal/db"
	"amiro/backend/internal/db/models"
)

func TestUserRepository_GetUserStats(t *testing.T) {
	dsn := filepath.Join(t.TempDir(), "test.db")
	gdb, err := db.Open(db.DialectSQLite, dsn)
	if err != nil {
		t.Fatalf("db.Open: %v", err)
	}

	repo := NewUserRepository(gdb)
	ctx := context.Background()

	// Create a test user
	user := models.User{
		ID:    "user-123",
		Name:  "Test User",
		Email: "test@example.com",
		Role:  "user",
	}
	if err := gdb.Create(&user).Error; err != nil {
		t.Fatalf("create user: %v", err)
	}

	// 1. Initial stats should be empty
	stats, err := repo.GetUserStats(ctx, "user-123")
	if err != nil {
		t.Fatalf("GetUserStats initial: %v", err)
	}
	if stats.ThreadCount != 0 || stats.MessageCount != 0 || stats.TotalTokens != 0 || len(stats.ModelStats) != 0 {
		t.Fatalf("expected empty stats, got %+v", stats)
	}

	// Create 2 threads for user-123
	t1 := models.ChatThread{
		ID:        "thread-1",
		UserID:    "user-123",
		Title:     "Thread 1",
		CreatedAt: time.Now().Add(-2 * time.Hour),
	}
	t2 := models.ChatThread{
		ID:        "thread-2",
		UserID:    "user-123",
		Title:     "Thread 2",
		CreatedAt: time.Now().Add(-1 * time.Hour),
	}
	if err := gdb.Create(&t1).Error; err != nil {
		t.Fatalf("create t1: %v", err)
	}
	if err := gdb.Create(&t2).Error; err != nil {
		t.Fatalf("create t2: %v", err)
	}

	// Create messages with metadata
	meta1, _ := json.Marshal(map[string]any{
		"usage":     map[string]any{"totalTokens": 150, "promptTokens": 100, "completionTokens": 50},
		"chatModel": map[string]any{"provider": "openai", "model": "gpt-4o"},
	})
	meta2, _ := json.Marshal(map[string]any{
		"usage":     map[string]any{"totalTokens": 250, "promptTokens": 200, "completionTokens": 50},
		"chatModel": map[string]any{"provider": "openai", "model": "gpt-4o"},
	})
	meta3, _ := json.Marshal(map[string]any{
		"usage":     map[string]any{"totalTokens": 600, "promptTokens": 400, "completionTokens": 200},
		"chatModel": map[string]any{"provider": "anthropic", "model": "claude-3-5-sonnet"},
	})

	m1 := models.ChatMessage{
		ID:        "msg-1",
		ThreadID:  "thread-1",
		Role:      "assistant",
		Parts:     datatypes.JSON(`[]`),
		Metadata:  datatypes.JSON(meta1),
		CreatedAt: time.Now().Add(-90 * time.Minute),
	}
	m2 := models.ChatMessage{
		ID:        "msg-2",
		ThreadID:  "thread-1",
		Role:      "assistant",
		Parts:     datatypes.JSON(`[]`),
		Metadata:  datatypes.JSON(meta2),
		CreatedAt: time.Now().Add(-80 * time.Minute),
	}
	m3 := models.ChatMessage{
		ID:        "msg-3",
		ThreadID:  "thread-2",
		Role:      "assistant",
		Parts:     datatypes.JSON(`[]`),
		Metadata:  datatypes.JSON(meta3),
		CreatedAt: time.Now().Add(-30 * time.Minute),
	}

	if err := gdb.Create(&m1).Error; err != nil {
		t.Fatalf("create m1: %v", err)
	}
	if err := gdb.Create(&m2).Error; err != nil {
		t.Fatalf("create m2: %v", err)
	}
	if err := gdb.Create(&m3).Error; err != nil {
		t.Fatalf("create m3: %v", err)
	}

	// Fetch stats
	stats, err = repo.GetUserStats(ctx, "user-123")
	if err != nil {
		t.Fatalf("GetUserStats: %v", err)
	}

	if stats.ThreadCount != 2 {
		t.Errorf("expected ThreadCount 2, got %d", stats.ThreadCount)
	}
	if stats.MessageCount != 3 {
		t.Errorf("expected MessageCount 3, got %d", stats.MessageCount)
	}
	if stats.TotalTokens != 1000 {
		t.Errorf("expected TotalTokens 1000, got %d", stats.TotalTokens)
	}
	if len(stats.ModelStats) != 2 {
		t.Fatalf("expected 2 ModelStats, got %d", len(stats.ModelStats))
	}

	if stats.PromptTokens != 700 {
		t.Errorf("expected PromptTokens 700, got %d", stats.PromptTokens)
	}
	if stats.CompletionTokens != 300 {
		t.Errorf("expected CompletionTokens 300, got %d", stats.CompletionTokens)
	}
	if stats.TotalCost <= 0 {
		t.Errorf("expected TotalCost > 0, got %v", stats.TotalCost)
	}
	if stats.PromptCost <= 0 || stats.CompletionCost <= 0 {
		t.Errorf("expected PromptCost > 0 and CompletionCost > 0, got prompt=%v completion=%v", stats.PromptCost, stats.CompletionCost)
	}
	if len(stats.DailyUsage) != 1 {
		t.Errorf("expected 1 DailyUsage item, got %d", len(stats.DailyUsage))
	} else {
		if stats.DailyUsage[0].TotalTokens != 1000 {
			t.Errorf("expected daily total tokens 1000, got %d", stats.DailyUsage[0].TotalTokens)
		}
		if stats.DailyUsage[0].TotalCost <= 0 {
			t.Errorf("expected daily total cost > 0, got %v", stats.DailyUsage[0].TotalCost)
		}
	}

	// claude-3-5-sonnet should be first because 600 > 400
	if stats.ModelStats[0].Model != "claude-3-5-sonnet" || stats.ModelStats[0].TotalTokens != 600 {
		t.Errorf("expected claude-3-5-sonnet first with 600 tokens, got %+v", stats.ModelStats[0])
	}
	if stats.ModelStats[0].TotalCost <= 0 {
		t.Errorf("expected claude-3-5-sonnet cost > 0, got %v", stats.ModelStats[0].TotalCost)
	}
	if stats.ModelStats[1].Model != "gpt-4o" || stats.ModelStats[1].TotalTokens != 400 || stats.ModelStats[1].MessageCount != 2 {
		t.Errorf("expected gpt-4o second with 400 tokens and 2 messages, got %+v", stats.ModelStats[1])
	}
	if stats.ModelStats[1].TotalCost <= 0 {
		t.Errorf("expected gpt-4o cost > 0, got %v", stats.ModelStats[1].TotalCost)
	}

	// Test with Days=1 (Today)
	days1 := 1
	statsToday, err := repo.GetUserStats(ctx, "user-123", UserStatsOptions{Days: &days1})
	if err != nil {
		t.Fatalf("GetUserStats today: %v", err)
	}
	if statsToday.Period != "Today" {
		t.Errorf("expected period 'Today', got %q", statsToday.Period)
	}
	if statsToday.TotalTokens != 1000 {
		t.Errorf("expected 1000 tokens for today, got %d", statsToday.TotalTokens)
	}

	// Test with custom date range in the past that should return 0
	pastFrom := time.Now().AddDate(0, 0, -60)
	pastTo := time.Now().AddDate(0, 0, -40)
	statsPast, err := repo.GetUserStats(ctx, "user-123", UserStatsOptions{From: &pastFrom, To: &pastTo})
	if err != nil {
		t.Fatalf("GetUserStats past: %v", err)
	}
	if statsPast.TotalTokens != 0 || statsPast.MessageCount != 0 {
		t.Errorf("expected 0 tokens for past window, got %+v", statsPast)
	}
}

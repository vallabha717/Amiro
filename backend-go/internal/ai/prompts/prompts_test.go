package prompts

import (
	"strings"
	"testing"

	"betterchatbot/backend/internal/db/models"
	"betterchatbot/backend/internal/user"
)

func TestBuildUserSystemPrompt_DefaultsToBetterChatbotAssistantName(t *testing.T) {
	got := BuildUserSystemPrompt(nil, nil, nil)
	if !strings.HasPrefix(got, "You are better-chatbot.") {
		t.Fatalf("got %q, want it to start with the default assistant name", got)
	}
}

func TestBuildUserSystemPrompt_UsesBotNamePreferenceWhenSet(t *testing.T) {
	got := BuildUserSystemPrompt(nil, &user.Preferences{BotName: "Vega"}, nil)
	if !strings.HasPrefix(got, "You are Vega.") {
		t.Fatalf("got %q, want it to start with the preferred bot name", got)
	}
}

func TestBuildUserSystemPrompt_IncludesUserNameAndEmailWhenPresent(t *testing.T) {
	u := &models.User{Name: "Ada", Email: "ada@example.com"}
	got := BuildUserSystemPrompt(u, nil, nil)
	if !strings.Contains(got, "Name: Ada") || !strings.Contains(got, "Email: ada@example.com") {
		t.Fatalf("got %q, want it to include the user's name and email", got)
	}
}

func TestBuildUserSystemPrompt_OmitsUserInformationBlockWhenNothingKnown(t *testing.T) {
	got := BuildUserSystemPrompt(nil, nil, nil)
	if strings.Contains(got, "<user_information>") {
		t.Fatalf("got %q, want no <user_information> block with no user/preferences", got)
	}
}

func TestBuildUserSystemPrompt_IncludesResponseStyleExampleWhenSet(t *testing.T) {
	got := BuildUserSystemPrompt(nil, &user.Preferences{ResponseStyleExample: "always rhyme"}, nil)
	if !strings.Contains(got, "always rhyme") {
		t.Fatalf("got %q, want it to include the response style example", got)
	}
}

func TestBuildSpeechSystemPrompt_DefaultsToAssistantName(t *testing.T) {
	got := BuildSpeechSystemPrompt(nil, nil)
	if !strings.HasPrefix(got, "You are Assistant.") {
		t.Fatalf("got %q, want it to start with the default voice assistant name", got)
	}
}

func TestBuildSpeechSystemPrompt_IncludesVoiceGuidelines(t *testing.T) {
	got := BuildSpeechSystemPrompt(nil, nil)
	if !strings.Contains(got, "<voice_interaction_guidelines>") {
		t.Fatalf("got %q, want the voice interaction guidelines section", got)
	}
}

func TestCreateThreadTitlePrompt_MentionsTitleLengthLimit(t *testing.T) {
	if !strings.Contains(CreateThreadTitlePrompt, "80 characters") {
		t.Fatalf("got %q, want the 80-character limit instruction", CreateThreadTitlePrompt)
	}
}

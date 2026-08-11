// Package speech holds the server-side half of src/lib/ai/speech/**.
//
// That directory is almost entirely client code and stays untouched by
// this rewrite, the same way src/lib/code-runner/** and @xyflow/react's
// graph editor do: use-voice-chat.openai.ts is a `"use client"` React hook
// that opens a WebRTC connection to OpenAI directly from the browser, and
// openai-realtime-event.ts is the TypeScript event union it decodes. The
// only piece that ever ran on a server is the tool list the realtime
// session is configured with, which is what lives here -- the session
// token itself is minted by internal/api/chat's OpenAIRealtime handler
// (plan section 4's "the server's job is just issuing that token").
//
// Text-to-speech and speech-to-text have no server-side implementation in
// better-chatbot at all (the realtime API does both inside the browser
// session), so there is nothing to port for them. Bifrost does expose
// SpeechRequest/TranscriptionRequest if a future phase wants a non-realtime
// path, but adding one now would be inventing a feature, not porting one.
package speech

// DefaultVoiceTools ports DEFAULT_VOICE_TOOLS (lib/ai/speech/index.ts:31):
// two tools the browser itself implements and executes, declared to the
// realtime session so the model knows it can call them. Not MCP tools --
// binding those into a realtime session is separate wiring the TS route
// does via loadMcpTools, still unported (see internal/api/chat's
// OpenAIRealtime doc comment).
func DefaultVoiceTools() []map[string]any {
	return []map[string]any{
		{
			"type":        "function",
			"name":        "changeBrowserTheme",
			"description": "Change the browser theme",
			"parameters": map[string]any{
				"type": "object",
				"properties": map[string]any{
					"theme": map[string]any{"type": "string", "enum": []string{"light", "dark"}},
				},
				"required": []string{"theme"},
			},
		},
		{
			"type":        "function",
			"name":        "endConversation",
			"description": "End the current voice conversation, similar to hanging up a call. This tool should be invoked when the user clearly expresses a desire to finish, exit, or end the dialogue.",
			"parameters": map[string]any{
				"type":       "object",
				"properties": map[string]any{},
				"required":   []string{},
			},
		},
	}
}

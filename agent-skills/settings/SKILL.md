---
name: settings
description: Change Amiro's own settings from chat - the chat model and LLM providers, web search providers, voice (text to speech, speech to text, read aloud) and image generation. Load it whenever the user asks to connect, switch, test or remove a model, provider, search engine, voice or image provider.
allowed-tools: mcp_call, mcp_search
metadata:
  emoji: "⚙️"
  amiro:
    display-name: "Settings"
    category: "system"
---

Every setting here has a tool on the built-in `amiro` server: `mcp_call { server: "amiro", tool: "<name>", intent: "...", arguments: {...} }`. Use them instead of reading config files. If you need an argument schema, `mcp_search` the tool name on server `amiro`.

**Keys never go through chat.** Tools that need one read it from the vault; when it is missing they return a secure card for the user to fill in. Never ask for a key in a message. `credentials_list` shows which keys are stored (names only).

## Models and providers

1. `provider_catalog`: every provider, how it signs in (OAuth, device code, API key, local endpoint), whether it is connected, and its models.
2. Connect:
   - Sign-in providers (Claude, OpenAI, Gemini, Copilot, Google): `provider_oauth_start`, then tell the user to finish in the card; confirm with `provider_oauth_status`.
   - API-key providers: `provider_configure_from_vault`. If the key is missing it returns the secure card; call it again once the user has saved it.
3. `provider_models` to list a provider's models; `provider_set_default_model` to make one the default for new chats.
4. `provider_disconnect` removes an API-key provider's stored key. Confirm first.

## Web search

`search_providers_list` shows the catalog, what is configured and which is active. `search_provider_configure` adds or updates one (DuckDuckGo needs no key), `search_provider_test` runs a live search, `search_provider_activate` makes it the default, `search_provider_delete` removes it.

## Voice

`voice_settings_get` shows the current speech setup and catalogs. `voice_list_voices` lists a provider's voices. `voice_config_update` changes the TTS provider, voice, model or speed, the STT provider, model or language (English, Hindi or auto), and read-aloud. Suggest a voice by name and let the user try it with read-aloud.

## Image generation

`image_provider_status` shows the provider and model in use; `image_provider_configure` sets 9Router, OpenAI, Gemini or an OpenAI-compatible API.

## Finish

Say in one line what changed and where to see it (Admin → Models & Providers, Search, Voice & Speech, or Image generation). `ui_navigate` can open that page for them. If a test fails, quote the error briefly and say what to fix.

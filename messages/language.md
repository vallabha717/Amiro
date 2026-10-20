# Adding a New Language

To add a new language to the application, follow these simple steps:

1. Copy the `messages/en.json` file and rename it to match your language code (e.g., `hi.json` for Hindi).

2. Translate all content in the file to your target language while maintaining the same JSON structure and keys.

3. Add your language to the `SUPPORTED_LOCALES` array in `src/lib/const.ts` file:

```typescript
export const SUPPORTED_LOCALES = [
  {
    code: "en",
    name: "English 🇺🇸",
  },
  {
    code: "hi",
    name: "हिन्दी (Hindi) 🇮🇳",
  },
  {
    code: "your-language-code",
    name: "Your Language Name 🏴",
  },
];
```

The language will then be available in the language selector of the application.

Amiro currently ships **English (`en`)** and **Hindi (`hi`)** only. Missing
keys in a locale fall back to English (`locale-provider.tsx` deep-merges over
`en.json`), but keep every locale complete. Check keys and `{placeholders}` against
`en.json` with:

```bash
pnpm check:i18n
```

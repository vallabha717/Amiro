/**
 * Shared secret detection patterns, storable credential slot mapping,
 * composer draft rewrites, and secret prompt parsing for Amiro.
 *
 * Single source of truth for:
 * 1. Prefix-based and token-shape secret detection (preventing secrets from entering chat).
 * 2. Mapping detected secret labels to credential vault slots.
 * 3. Rewriting composer drafts to replace plaintext secrets with secure vault references.
 * 4. Parsing agent secret prompts (`SECRET_PROMPT {...}`, `<secret_prompt>`, applets, or tool calls).
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface SecretPrefixPattern {
  /** Human-readable label shown in block notices and redaction tags. */
  label: string;
  /**
   * Regex that matches the token value. Must NOT include the `g` flag or
   * capture groups.
   */
  regex: RegExp;
}

export interface DetectedSecret {
  /** Human-readable secret type label, e.g. "Anthropic API Key". */
  label: string;
  /** The matched secret text. */
  value: string;
  /** Start offset of the match in the scanned text (inclusive). */
  start: number;
  /** End offset of the match in the scanned text (exclusive). */
  end: number;
  /** True when the entire trimmed text is one token-shaped value. */
  wholeMessage: boolean;
}

/** Vault slot (service + field) a detected secret is stored under. */
export interface CredentialSlot {
  service: string;
  field: string;
}

export interface ParsedSecretPrompt {
  id: string;
  service: string;
  field: string;
  label: string;
  description?: string;
  placeholder?: string;
  purpose?: string;
  allowedDomains?: string[];
  allowedTools?: string[];
}

// ---------------------------------------------------------------------------
// Prefix patterns & PEM constants
// ---------------------------------------------------------------------------

/** Detection label for PEM private-key matches. */
export const PRIVATE_KEY_LABEL = "Private Key";

// PEM private-key header/footer type variants
export const PEM_KEY_TYPE = String.raw`(?:RSA |DSA |EC |OPENSSH |PGP )?PRIVATE KEY(?:\s+BLOCK)?`;
export const PEM_BEGIN = String.raw`-----BEGIN ${PEM_KEY_TYPE}-----`;
export const PEM_END = String.raw`-----END ${PEM_KEY_TYPE}-----`;

export const PEM_COMPLETE_BLOCK = new RegExp(`${PEM_END}$`);

/**
 * Whole-block PEM body atom: one tempered body character. `(?!-----BEGIN)`
 * keeps the body from crossing into an adjacent block.
 */
export const PEM_BLOCK_TAIL = String.raw`(?:(?!-----BEGIN)[\s\S])`;

/**
 * Upper bound on the PEM body scan distance for the redaction matcher.
 */
export const PEM_REDACTION_MAX_BODY_LENGTH = 16384;

/**
 * Whole-block private-key matcher for detect-and-redact consumers.
 */
export const PRIVATE_KEY_REDACTION_REGEX = new RegExp(
  `${PEM_BEGIN}(?:${PEM_BLOCK_TAIL}{0,${PEM_REDACTION_MAX_BODY_LENGTH}}?${PEM_END})?`,
);

/**
 * True when a `Private Key` match is a complete PEM block ending in an END footer.
 */
export function isCompletePrivateKeyBlock(value: string): boolean {
  return PEM_COMPLETE_BLOCK.test(value);
}

export const PREFIX_PATTERNS: SecretPrefixPattern[] = [
  // -- Private keys --
  {
    label: PRIVATE_KEY_LABEL,
    regex: new RegExp(`${PEM_BEGIN}(?:${PEM_BLOCK_TAIL}*?${PEM_END})?`),
  },

  // -- AWS --
  { label: "AWS Access Key", regex: /AKIA[0-9A-Z]{16}/ },

  // -- GitHub --
  { label: "GitHub Token", regex: /gh[pousr]_[A-Za-z0-9_]{36,}/ },
  { label: "GitHub Fine-Grained PAT", regex: /github_pat_[A-Za-z0-9_]{22,}/ },

  // -- GitLab --
  { label: "GitLab Token", regex: /glpat-[A-Za-z0-9\-_]{20,}/ },

  // -- Stripe --
  { label: "Stripe Secret Key", regex: /sk_live_[A-Za-z0-9]{24,}/ },
  { label: "Stripe Restricted Key", regex: /rk_live_[A-Za-z0-9]{24,}/ },
  { label: "Link Access Token", regex: /liwltoken_[A-Za-z0-9]{16,}/ },
  { label: "Link Refresh Token", regex: /liwlrefresh_[A-Za-z0-9]{16,}/ },

  // -- Slack --
  {
    label: "Slack Bot Token",
    regex: /xoxb-[0-9]{10,}-[0-9]{10,}-[A-Za-z0-9]{24,}/,
  },
  {
    label: "Slack User Token",
    regex: /xoxp-[0-9]{10,}-[0-9]{10,}-[0-9]{10,}-[a-f0-9]{32}/,
  },
  {
    label: "Slack App Token",
    regex: /xapp-[0-9]+-[A-Za-z0-9]+-[0-9]+-[A-Za-z0-9]+/,
  },

  // -- Telegram --
  {
    label: "Telegram Bot Token",
    regex: /[0-9]{8,10}:[A-Za-z0-9_-]{35}/,
  },

  // -- Anthropic --
  { label: "Anthropic API Key", regex: /sk-ant-[A-Za-z0-9\-_]{80,}/ },

  // -- OpenAI --
  {
    label: "OpenAI API Key",
    regex: /sk-[A-Za-z0-9]{20}T3BlbkFJ[A-Za-z0-9]{20}/,
  },
  { label: "OpenAI Project Key", regex: /sk-proj-[A-Za-z0-9\-_]{40,}/ },

  // -- Google --
  { label: "Google API Key", regex: /AIza[A-Za-z0-9\-_]{35}/ },
  {
    label: "Google OAuth Client Secret",
    regex: /GOCSPX-[A-Za-z0-9\-_]{28}/,
  },

  // -- Twilio --
  { label: "Twilio API Key", regex: /SK[0-9a-f]{32}/ },

  // -- SendGrid --
  {
    label: "SendGrid API Key",
    regex: /SG\.[A-Za-z0-9\-_]{22}\.[A-Za-z0-9\-_]{43}/,
  },

  // -- Mailgun --
  { label: "Mailgun API Key", regex: /key-[A-Za-z0-9]{32}/ },

  // -- npm --
  { label: "npm Token", regex: /npm_[A-Za-z0-9]{36}/ },

  // -- PyPI --
  { label: "PyPI API Token", regex: /pypi-[A-Za-z0-9\-_]{50,}/ },

  // -- Linear --
  { label: "Linear API Key", regex: /lin_api_[A-Za-z0-9]{32,}/ },

  // -- Notion --
  { label: "Notion Integration Token", regex: /ntn_[A-Za-z0-9]{40,}/ },

  // -- OpenRouter --
  { label: "OpenRouter API Key", regex: /sk-or-v1-[A-Za-z0-9\-_]{40,}/ },

  // -- Vercel AI Gateway --
  { label: "Vercel AI Gateway API Key", regex: /vck_[A-Za-z0-9\-_]{24,}/ },

  // -- Fireworks --
  { label: "Fireworks API Key", regex: /fw_[A-Za-z0-9]{32,}/ },

  // -- Perplexity --
  { label: "Perplexity API Key", regex: /pplx-[A-Za-z0-9]{40,}/ },

  // -- Tavily --
  { label: "Tavily API Key", regex: /tvly-[A-Za-z0-9]{20,}/ },

  // -- Firecrawl --
  { label: "Firecrawl API Key", regex: /fc-[A-Za-z0-9]{20,}/ },

  // -- Resend --
  { label: "Resend API Key", regex: /re_[A-Za-z0-9]{8}_[A-Za-z0-9]{24,}/ },
];

export const REDACTION_PREFIX_PATTERNS: SecretPrefixPattern[] =
  PREFIX_PATTERNS.map((p) =>
    p.label === PRIVATE_KEY_LABEL
      ? { label: PRIVATE_KEY_LABEL, regex: PRIVATE_KEY_REDACTION_REGEX }
      : p,
  );

// ---------------------------------------------------------------------------
// Token-shape heuristic (whole-message only)
// ---------------------------------------------------------------------------

export const TOKEN_SHAPE =
  /^[A-Za-z0-9][A-Za-z0-9_-]*[_-](?:tkn|token|key|secret|api|pat|sk|auth)[_-]([A-Za-z0-9_-]{16,})$/i;

export const TOKEN_SHAPE_MIN_LENGTH = 20;
export const TOKEN_SHAPE_MAX_LENGTH = 512;
export const TOKEN_SHAPE_LABEL = "Token-shaped value";

// ---------------------------------------------------------------------------
// Placeholder suppression
// ---------------------------------------------------------------------------

export const KNOWN_PLACEHOLDERS = new Set([
  "your-api-key-here",
  "your_api_key_here",
  "insert-your-key-here",
  "insert_your_key_here",
  "replace-with-your-key",
  "replace_with_your_key",
  "xxx",
  "xxxxxxxx",
  "test",
  "example",
  "sample",
  "demo",
  "placeholder",
  "changeme",
  "CHANGEME",
  "TODO",
  "FIXME",
  "your-token-here",
  "your_token_here",
  "my-api-key",
  "my_api_key",
]);

export const PLACEHOLDER_PREFIXES = [
  "sk-test-",
  "sk_test_",
  "fake_",
  "fake-",
  "dummy_",
  "dummy-",
  "test_",
  "test-",
  "example_",
  "example-",
  "sample_",
  "sample-",
  "mock_",
  "mock-",
];

export function isPlaceholderContext(preContext: string): boolean {
  const lower = preContext.toLowerCase();
  for (const prefix of PLACEHOLDER_PREFIXES) {
    if (lower.endsWith(prefix)) {
      return true;
    }
  }
  return false;
}

export function isPlaceholderValue(value: string): boolean {
  const lower = value.toLowerCase();
  if (KNOWN_PLACEHOLDERS.has(value) || KNOWN_PLACEHOLDERS.has(lower)) {
    return true;
  }
  for (const prefix of PLACEHOLDER_PREFIXES) {
    if (lower.startsWith(prefix)) {
      return true;
    }
  }

  // Repeated characters in the variable portion
  const variablePart = value
    .replace(
      /^(?:AKIA|gh[pousr]_|github_pat_|glpat-|sk_live_|rk_live_|xoxb-|xoxp-|xapp-|sk-ant-|sk-proj-|sk-or-v1-|AIza|GOCSPX-|SK|SG\.|npm_|pypi-|key-|lin_api_|ntn_|fw_|pplx-|re_|-----BEGIN [A-Z ]*PRIVATE KEY-----)/,
      "",
    )
    .replace(/[^A-Za-z0-9]/g, "");
  if (variablePart.length >= 8) {
    const firstChar = variablePart[0];
    if (variablePart.split("").every((c) => c === firstChar)) {
      return true;
    }
  }

  return false;
}

// ---------------------------------------------------------------------------
// Draft scanner
// ---------------------------------------------------------------------------

const GLOBAL_PREFIX_PATTERNS: SecretPrefixPattern[] = PREFIX_PATTERNS.map(
  ({ label, regex }) => ({
    label,
    regex: new RegExp(
      regex.source,
      regex.flags.includes("g") ? regex.flags : `${regex.flags}g`,
    ),
  }),
);

export function detectSecretsInText(text: string): DetectedSecret[] {
  if (!text) return [];
  const matches: DetectedSecret[] = [];

  for (const { label, regex } of GLOBAL_PREFIX_PATTERNS) {
    regex.lastIndex = 0;
    let match: RegExpExecArray | null;

    while ((match = regex.exec(text)) !== null) {
      const value = match[0];
      const contextStart = Math.max(0, match.index - 10);
      const preContext = text.slice(contextStart, match.index);
      if (isPlaceholderValue(value) || isPlaceholderContext(preContext)) {
        continue;
      }
      const start = match.index;
      const end = start + value.length;
      if (matches.some((m) => start < m.end && end > m.start)) {
        continue;
      }
      matches.push({ label, value, start, end, wholeMessage: false });
    }
  }

  if (matches.length === 0) {
    const trimmed = text.trim();
    const shapeMatch =
      trimmed.length >= TOKEN_SHAPE_MIN_LENGTH &&
      trimmed.length <= TOKEN_SHAPE_MAX_LENGTH
        ? TOKEN_SHAPE.exec(trimmed)
        : null;
    if (
      shapeMatch !== null &&
      !isPlaceholderValue(trimmed) &&
      !isPlaceholderValue(shapeMatch[1] ?? "")
    ) {
      const start = text.length - text.trimStart().length;
      matches.push({
        label: TOKEN_SHAPE_LABEL,
        value: trimmed,
        start,
        end: start + trimmed.length,
        wholeMessage: true,
      });
    }
  }

  return matches.sort((a, b) => a.start - b.start);
}

// ---------------------------------------------------------------------------
// Vault slot suggestions and draft rewrite helpers
// ---------------------------------------------------------------------------

export const UNKNOWN_SLOT: CredentialSlot = { service: "", field: "" };

export const SLOT_BY_DETECTION_LABEL: Record<string, CredentialSlot> = {
  "AWS Access Key": { service: "aws", field: "access_key_id" },
  "GitHub Token": { service: "github", field: "token" },
  "GitHub Fine-Grained PAT": { service: "github", field: "token" },
  "GitLab Token": { service: "gitlab", field: "token" },
  "Stripe Secret Key": { service: "stripe", field: "secret_key" },
  "Stripe Restricted Key": { service: "stripe", field: "restricted_key" },
  "Link Access Token": { service: "stripe_link", field: "access_token" },
  "Link Refresh Token": { service: "stripe_link", field: "refresh_token" },
  "Slack Bot Token": { service: "slack_channel", field: "bot_token" },
  "Slack User Token": { service: "slack_channel", field: "user_token" },
  "Slack App Token": { service: "slack_channel", field: "app_token" },
  "Telegram Bot Token": { service: "telegram", field: "bot_token" },
  "Anthropic API Key": { service: "anthropic", field: "api_key" },
  "OpenAI API Key": { service: "openai", field: "api_key" },
  "OpenAI Project Key": { service: "openai", field: "api_key" },
  "Google API Key": { service: "google", field: "api_key" },
  "Google OAuth Client Secret": {
    service: "google",
    field: "oauth_client_secret",
  },
  "Twilio API Key": { service: "twilio", field: "api_key" },
  "SendGrid API Key": { service: "sendgrid", field: "api_key" },
  "Mailgun API Key": { service: "mailgun", field: "api_key" },
  "npm Token": { service: "npm", field: "token" },
  "PyPI API Token": { service: "pypi", field: "api_token" },
  "Linear API Key": { service: "linear", field: "api_key" },
  "Notion Integration Token": {
    service: "notion",
    field: "integration_token",
  },
  "OpenRouter API Key": { service: "openrouter", field: "api_key" },
  "Vercel AI Gateway API Key": {
    service: "vercel",
    field: "ai_gateway_api_key",
  },
  "Fireworks API Key": { service: "fireworks", field: "api_key" },
  "Perplexity API Key": { service: "perplexity", field: "api_key" },
  "Tavily API Key": { service: "tavily", field: "api_key" },
  "Firecrawl API Key": { service: "firecrawl", field: "api_key" },
  "Resend API Key": { service: "resend", field: "api_key" },
};

/**
 * Suggests credential slot based on detection label.
 */
export function suggestCredentialSlot(label: string): CredentialSlot {
  return SLOT_BY_DETECTION_LABEL[label] ?? UNKNOWN_SLOT;
}

/**
 * Checks if the secret is storable. Incomplete private key blocks (missing END footer)
 * cannot be fully stored or replaced safely.
 */
export function isStorableSecret(secret: DetectedSecret): boolean {
  return (
    secret.label !== PRIVATE_KEY_LABEL ||
    isCompletePrivateKeyBlock(secret.value)
  );
}

/**
 * Checks if the secret is present in the composer input and is storable.
 */
export function isStorableFromInput(
  secret: DetectedSecret,
  composerInput: string,
): boolean {
  return isStorableSecret(secret) && composerInput.includes(secret.value);
}

/**
 * Rewrites the draft replacing the secret value with a reference to the stored vault slot.
 */
export function rewriteDraftWithStoredCredential(
  draft: string,
  secretValue: string,
  slot: CredentialSlot,
): string {
  return draft.replaceAll(
    secretValue,
    `[stored securely as ${slot.service}/${slot.field}]`,
  );
}

const MASK_VISIBLE_CHARS = 6;
const MASK_BULLETS = "•".repeat(8);

/**
 * Returns a masked preview of a secret (first 6 characters followed by bullets).
 */
export function maskSecretValue(value: string): string {
  return `${value.slice(0, MASK_VISIBLE_CHARS)}${MASK_BULLETS}`;
}

// ---------------------------------------------------------------------------
// Secret prompt parser
// ---------------------------------------------------------------------------

function extractAttributes(attrString: string): Record<string, string> {
  const result: Record<string, string> = {};
  const attrRegex = /([a-zA-Z0-9_-]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/g;
  let match: RegExpExecArray | null;
  while ((match = attrRegex.exec(attrString)) !== null) {
    const key = match[1];
    const val = match[2] ?? match[3] ?? match[4] ?? "";
    if (key) {
      result[key] = val;
    }
  }
  return result;
}

function coerceSecretPrompt(raw: any): ParsedSecretPrompt | null {
  if (!raw || typeof raw !== "object") return null;

  const service = typeof raw.service === "string" ? raw.service.trim() : "";
  const field = typeof raw.field === "string" ? raw.field.trim() : "";
  if (!service || !field) return null;

  const id =
    typeof raw.id === "string" && raw.id.trim()
      ? raw.id.trim()
      : `${service}:${field}`;

  const label =
    typeof raw.label === "string" && raw.label.trim()
      ? raw.label.trim()
      : `${service}/${field}`;

  const description =
    typeof raw.description === "string" && raw.description.trim()
      ? raw.description.trim()
      : undefined;

  const placeholder =
    typeof raw.placeholder === "string" && raw.placeholder.trim()
      ? raw.placeholder.trim()
      : undefined;

  const purpose =
    typeof raw.purpose === "string" && raw.purpose.trim()
      ? raw.purpose.trim()
      : undefined;

  const allowedDomains = Array.isArray(raw.allowedDomains)
    ? raw.allowedDomains.map(String).filter(Boolean)
    : undefined;

  const allowedTools = Array.isArray(raw.allowedTools)
    ? raw.allowedTools.map(String).filter(Boolean)
    : undefined;

  return {
    id,
    service,
    field,
    label,
    description,
    placeholder,
    purpose,
    allowedDomains,
    allowedTools,
  };
}

/**
 * Detects when an agent or tool outputs a secret prompt request.
 *
 * Supports:
 * 1. String text containing `SECRET_PROMPT {...}` or `SECRET_PROMPT: {...}`
 * 2. String text containing `<secret_prompt ...>` XML tags
 * 3. Tool call / applet object where:
 *    - `type === "secret_prompt"` or `action === "secret_prompt"`
 *    - `tool === "request_credential"` or `name === "request_credential"`
 *    - `input` or `view` specifies a credential prompt
 */
export function parseSecretPrompt(inputOrOutput: unknown): ParsedSecretPrompt | null {
  if (!inputOrOutput) return null;

  // Case 1: Plain string parsing
  if (typeof inputOrOutput === "string") {
    const text = inputOrOutput.trim();

    // Pattern A: SECRET_PROMPT { ... }
    const markerRegex = /SECRET_PROMPT\s*:?\s*(\{[\s\S]*?\})/i;
    const markerMatch = markerRegex.exec(text);
    if (markerMatch && markerMatch[1]) {
      try {
        const parsed = JSON.parse(markerMatch[1]);
        const prompt = coerceSecretPrompt(parsed);
        if (prompt) return prompt;
      } catch {
        // Continue fallback
      }
    }

    // Pattern B: <secret_prompt ...> ... </secret_prompt> or <secret_prompt ... />
    const xmlRegex = /<secret_prompt\b([^>]*)>(?:([\s\S]*?)<\/secret_prompt>)?/i;
    const xmlMatch = xmlRegex.exec(text);
    if (xmlMatch) {
      const attrs = extractAttributes(xmlMatch[1] ?? "");
      const inner = (xmlMatch[2] ?? "").trim();
      let innerJson: any = {};
      if (inner.startsWith("{") && inner.endsWith("}")) {
        try {
          innerJson = JSON.parse(inner);
        } catch {
          // ignore
        }
      }
      const merged = { ...attrs, ...innerJson };
      const prompt = coerceSecretPrompt(merged);
      if (prompt) return prompt;
    }

    // Pattern C: The whole string is a JSON object
    if (text.startsWith("{") && text.endsWith("}")) {
      try {
        const parsed = JSON.parse(text);
        const prompt = parseSecretPrompt(parsed);
        if (prompt) return prompt;
      } catch {
        // ignore
      }
    }

    return null;
  }

  // Case 2: Object representation (tool call, applet, view, payload)
  if (typeof inputOrOutput === "object") {
    const obj = inputOrOutput as Record<string, any>;

    // Direct object with service and field
    if (
      obj.type === "secret_prompt" ||
      obj.action === "secret_prompt" ||
      obj.name === "request_credential" ||
      obj.tool === "request_credential" ||
      obj.action === "request_credential" ||
      (typeof obj.service === "string" && typeof obj.field === "string")
    ) {
      const direct = coerceSecretPrompt(obj);
      if (direct) return direct;
    }

    // Nested structures: applet input, view, arguments, params, data, prompt
    const candidates = [
      obj.input,
      obj.view,
      obj.arguments,
      obj.args,
      obj.params,
      obj.parameters,
      obj.data,
      obj.props,
      obj.prompt,
      obj.secret,
      obj.credential,
    ];

    for (const candidate of candidates) {
      if (!candidate) continue;
      const parsed = parseSecretPrompt(candidate);
      if (parsed) return parsed;
    }

    // Tool output or message content strings
    if (typeof obj.output === "string") {
      const parsed = parseSecretPrompt(obj.output);
      if (parsed) return parsed;
    }
    if (typeof obj.content === "string") {
      const parsed = parseSecretPrompt(obj.content);
      if (parsed) return parsed;
    }
    if (typeof obj.text === "string") {
      const parsed = parseSecretPrompt(obj.text);
      if (parsed) return parsed;
    }
  }

  return null;
}

export interface ParsedOAuthConnect {
  id: string;
  type: "provider" | "mcp" | "composio" | "custom";
  provider?: string;
  server?: string;
  toolkit?: string;
  connectionId?: string;
  flow?: "authorization_code" | "device_code";
  authorizationUrl?: string;
  redirectUrl?: string;
  userCode?: string;
  verificationUri?: string;
}

export function parseOAuthConnect(inputOrOutput: unknown): ParsedOAuthConnect | null {
  if (!inputOrOutput) return null;

  if (typeof inputOrOutput === "string") {
    const text = inputOrOutput.trim();
    const markerRegex = /OAUTH_CONNECT\s*:?\s*(\{[\s\S]*?\})/i;
    const match = markerRegex.exec(text);
    if (match && match[1]) {
      try {
        const parsed = JSON.parse(match[1]);
        if (parsed && typeof parsed === "object") {
          return {
            id: parsed.id || `oauth-${Date.now()}`,
            type: parsed.type || (parsed.provider ? "provider" : parsed.toolkit ? "composio" : "mcp"),
            provider: parsed.provider,
            server: parsed.server,
            toolkit: parsed.toolkit,
            connectionId: parsed.connectionId || parsed.connection_id,
            flow: parsed.flow,
            authorizationUrl: parsed.authorizationUrl || parsed.authorization_url || parsed.redirectUrl || parsed.redirect_url,
            redirectUrl: parsed.redirectUrl || parsed.redirect_url,
            userCode: parsed.userCode || parsed.user_code,
            verificationUri: parsed.verificationUri || parsed.verification_uri,
          };
        }
      } catch {
        // ignore
      }
    }
    return null;
  }

  if (typeof inputOrOutput === "object") {
    const obj = inputOrOutput as Record<string, any>;
    if (obj.authorizationUrl || obj.authorization_url || obj.redirectUrl || obj.userCode || obj.user_code) {
      return {
        id: obj.id || `oauth-${Date.now()}`,
        type: obj.type || (obj.provider ? "provider" : obj.toolkit ? "composio" : "mcp"),
        provider: obj.provider,
        server: obj.server,
        toolkit: obj.toolkit,
        connectionId: obj.connectionId || obj.connection_id,
        flow: obj.flow,
        authorizationUrl: obj.authorizationUrl || obj.authorization_url || obj.redirectUrl || obj.redirect_url,
        redirectUrl: obj.redirectUrl || obj.redirect_url,
        userCode: obj.userCode || obj.user_code,
        verificationUri: obj.verificationUri || obj.verification_uri,
      };
    }
  }

  return null;
}


import { describe, expect, it } from "vitest";

import {
  detectSecretsInText,
  isCompletePrivateKeyBlock,
  isPlaceholderContext,
  isPlaceholderValue,
  isStorableFromInput,
  isStorableSecret,
  maskSecretValue,
  parseSecretPrompt,
  PREFIX_PATTERNS,
  rewriteDraftWithStoredCredential,
  suggestCredentialSlot,
  TOKEN_SHAPE,
  TOKEN_SHAPE_LABEL,
  UNKNOWN_SLOT,
} from "./secret-detection";

const ALNUM = "abcdefghijklmnopqrstuvwxyz0123456789";

function filler(length: number): string {
  return ALNUM.repeat(Math.ceil(length / ALNUM.length)).slice(0, length);
}

const FIXTURES: Record<string, string> = {
  "AWS Access Key": "AKIAABCDEFGHIJKLMNOP",
  "GitHub Token": `ghp_${filler(36)}`,
  "GitHub Fine-Grained PAT": `github_pat_${filler(22)}`,
  "GitLab Token": `glpat-${filler(20)}`,
  "Stripe Secret Key": `sk_live_${filler(24)}`,
  "Stripe Restricted Key": `rk_live_${filler(24)}`,
  "Link Access Token": `liwltoken_${filler(24)}`,
  "Link Refresh Token": `liwlrefresh_${filler(24)}`,
  "Slack Bot Token": `xoxb-1234567890-1234567890-${filler(24)}`,
  "Slack User Token": `xoxp-1234567890-1234567890-1234567890-${"0123456789abcdef".repeat(2)}`,
  "Slack App Token": "xapp-1-abc123-4567-defghij890",
  "Telegram Bot Token": `123456789:${filler(35)}`,
  "Anthropic API Key": `sk-ant-${filler(80)}`,
  "OpenAI API Key": `sk-${filler(20)}T3BlbkFJ${filler(20)}`,
  "OpenAI Project Key": `sk-proj-${filler(40)}`,
  "Google API Key": `AIza${filler(35)}`,
  "Google OAuth Client Secret": `GOCSPX-${filler(28)}`,
  "Twilio API Key": `SK${"0123456789abcdef".repeat(2)}`,
  "SendGrid API Key": `SG.${filler(22)}.${filler(43)}`,
  "Mailgun API Key": `key-${filler(32)}`,
  "npm Token": `npm_${filler(36)}`,
  "PyPI API Token": `pypi-${filler(50)}`,
  "Private Key": "-----BEGIN OPENSSH PRIVATE KEY-----",
  "Linear API Key": `lin_api_${filler(32)}`,
  "Notion Integration Token": `ntn_${filler(40)}`,
  "OpenRouter API Key": `sk-or-v1-${filler(40)}`,
  "Vercel AI Gateway API Key": `vck_${filler(24)}`,
  "Fireworks API Key": `fw_${filler(32)}`,
  "Perplexity API Key": `pplx-${filler(40)}`,
  "Tavily API Key": `tvly-${filler(20)}`,
  "Firecrawl API Key": `fc-${filler(20)}`,
  "Resend API Key": `re_${filler(8)}_${filler(24)}`,
};

describe("PREFIX_PATTERNS", () => {
  it("has a fixture for every pattern", () => {
    expect(Object.keys(FIXTURES).sort()).toEqual(
      PREFIX_PATTERNS.map((p) => p.label).sort(),
    );
  });

  it("has unique labels for every pattern", () => {
    const labels = PREFIX_PATTERNS.map((p) => p.label);
    expect(new Set(labels).size).toBe(labels.length);
  });
});

describe("detectSecretsInText", () => {
  it.each(Object.entries(FIXTURES))(
    "detects %s with exact label and boundaries",
    (label, fixture) => {
      const text = `Please use this key: ${fixture} in the config`;
      const matches = detectSecretsInText(text);
      expect(matches.length).toBe(1);
      expect(matches[0]?.label).toBe(label);
      expect(matches[0]?.value).toBe(fixture);
      expect(matches[0]?.start).toBe(text.indexOf(fixture));
      expect(matches[0]?.end).toBe(text.indexOf(fixture) + fixture.length);
      expect(matches[0]?.wholeMessage).toBe(false);
    },
  );

  it("returns empty array for empty or safe text", () => {
    expect(detectSecretsInText("")).toEqual([]);
    expect(detectSecretsInText("Hello world! Just a normal message.")).toEqual([]);
  });

  it("detects whole-message token shape", () => {
    const token = `virlo_tkn_${filler(20)}`;
    expect(TOKEN_SHAPE.test(token)).toBe(true);

    const matches = detectSecretsInText(token);
    expect(matches).toEqual([
      {
        label: TOKEN_SHAPE_LABEL,
        value: token,
        start: 0,
        end: token.length,
        wholeMessage: true,
      },
    ]);
  });

  it("trims surrounding whitespace for whole-message token shape", () => {
    const token = `acme_secret_${filler(18)}`;
    const padded = `   ${token}   `;
    const matches = detectSecretsInText(padded);
    expect(matches).toEqual([
      {
        label: TOKEN_SHAPE_LABEL,
        value: token,
        start: 3,
        end: 3 + token.length,
        wholeMessage: true,
      },
    ]);
  });

  it("does not match token shape if embedded in a sentence", () => {
    const token = `virlo_tkn_${filler(20)}`;
    const text = `Here is my custom token ${token} for the service`;
    expect(detectSecretsInText(text)).toEqual([]);
  });
});

describe("Placeholder suppression", () => {
  it("suppresses known placeholder values", () => {
    expect(isPlaceholderValue("your-api-key-here")).toBe(true);
    expect(isPlaceholderValue("TODO")).toBe(true);
    expect(isPlaceholderValue("changeme")).toBe(true);
    expect(detectSecretsInText("your-api-key-here")).toEqual([]);
    expect(detectSecretsInText("sk-xxxxxxxxxxxxxxxxxxxxxxxx")).toEqual([]);
  });

  it("suppresses placeholder prefixes", () => {
    expect(isPlaceholderValue("fake_key_12345678901234567890")).toBe(true);
    expect(isPlaceholderValue("dummy-token-12345678901234567890")).toBe(true);
    expect(isPlaceholderValue("test_api_12345678901234567890")).toBe(true);
    expect(detectSecretsInText(`fake_key_${filler(20)}`)).toEqual([]);
  });

  it("suppresses placeholder pre-context like fake_ghp_...", () => {
    const fakeKey = `fake_ghp_${filler(36)}`;
    expect(isPlaceholderContext("fake_")).toBe(true);
    expect(detectSecretsInText(fakeKey)).toEqual([]);
    expect(detectSecretsInText(`example_ghp_${filler(36)}`)).toEqual([]);
  });

  it("suppresses repeated character variable portions", () => {
    expect(isPlaceholderValue("AKIAXXXXXXXXXXXXXXXX")).toBe(true);
    expect(detectSecretsInText("AKIAXXXXXXXXXXXXXXXX")).toEqual([]);
    expect(detectSecretsInText(`my_key_${"x".repeat(18)}`)).toEqual([]);
  });
});

describe("Private Key helpers", () => {
  const completeKey =
    "-----BEGIN RSA PRIVATE KEY-----\nMIIEowIBAAKCAQEA0...\n-----END RSA PRIVATE KEY-----";
  const incompleteKey = "-----BEGIN RSA PRIVATE KEY-----\nMIIEowIBAAKCAQEA0...";

  it("correctly identifies complete vs incomplete PEM blocks", () => {
    expect(isCompletePrivateKeyBlock(completeKey)).toBe(true);
    expect(isCompletePrivateKeyBlock(incompleteKey)).toBe(false);
  });

  it("determines if a secret is storable", () => {
    const completeSecret = {
      label: "Private Key",
      value: completeKey,
      start: 0,
      end: completeKey.length,
      wholeMessage: false,
    };
    const incompleteSecret = {
      label: "Private Key",
      value: incompleteKey,
      start: 0,
      end: incompleteKey.length,
      wholeMessage: false,
    };
    const standardSecret = {
      label: "OpenAI API Key",
      value: "sk-proj-1234567890123456789012345678901234567890",
      start: 0,
      end: 48,
      wholeMessage: false,
    };

    expect(isStorableSecret(completeSecret)).toBe(true);
    expect(isStorableSecret(incompleteSecret)).toBe(false);
    expect(isStorableSecret(standardSecret)).toBe(true);
  });

  it("isStorableFromInput requires the secret to be present in input and storable", () => {
    const secret = {
      label: "OpenAI API Key",
      value: "sk-proj-1234567890123456789012345678901234567890",
      start: 0,
      end: 48,
      wholeMessage: false,
    };

    expect(isStorableFromInput(secret, "here is sk-proj-1234567890123456789012345678901234567890 in my draft")).toBe(true);
    expect(isStorableFromInput(secret, "no key here in my draft")).toBe(false);

    const incompleteSecret = {
      label: "Private Key",
      value: incompleteKey,
      start: 0,
      end: incompleteKey.length,
      wholeMessage: false,
    };
    expect(isStorableFromInput(incompleteSecret, incompleteKey)).toBe(false);
  });
});

describe("suggestCredentialSlot", () => {
  it("maps known detection labels to service and field", () => {
    expect(suggestCredentialSlot("OpenAI API Key")).toEqual({
      service: "openai",
      field: "api_key",
    });
    expect(suggestCredentialSlot("Anthropic API Key")).toEqual({
      service: "anthropic",
      field: "api_key",
    });
    expect(suggestCredentialSlot("AWS Access Key")).toEqual({
      service: "aws",
      field: "access_key_id",
    });
    expect(suggestCredentialSlot("GitHub Token")).toEqual({
      service: "github",
      field: "token",
    });
    expect(suggestCredentialSlot("Stripe Secret Key")).toEqual({
      service: "stripe",
      field: "secret_key",
    });
    expect(suggestCredentialSlot("Slack Bot Token")).toEqual({
      service: "slack_channel",
      field: "bot_token",
    });
  });

  it("returns UNKNOWN_SLOT for unknown labels", () => {
    expect(suggestCredentialSlot("Unknown Service")).toEqual(UNKNOWN_SLOT);
    expect(suggestCredentialSlot(TOKEN_SHAPE_LABEL)).toEqual(UNKNOWN_SLOT);
  });
});

describe("rewriteDraftWithStoredCredential", () => {
  it("replaces secret occurrences with stored credential reference", () => {
    const secret = "sk-proj-test123456789012345678901234567890";
    const draft = `My key is ${secret}. Please use ${secret} for calling OpenAI.`;
    const rewritten = rewriteDraftWithStoredCredential(draft, secret, {
      service: "openai",
      field: "api_key",
    });

    expect(rewritten).toBe(
      "My key is [stored securely as openai/api_key]. Please use [stored securely as openai/api_key] for calling OpenAI.",
    );
  });
});

describe("maskSecretValue", () => {
  it("masks the secret value with 6 visible leading chars and 8 bullets", () => {
    const secret = "sk-proj-1234567890abcdef123456";
    expect(maskSecretValue(secret)).toBe("sk-pro••••••••");
  });

  it("handles short values cleanly", () => {
    expect(maskSecretValue("AKIA12")).toBe("AKIA12••••••••");
  });
});

describe("parseSecretPrompt", () => {
  it("parses SECRET_PROMPT marker in string output", () => {
    const raw = `Please provide your credentials:
SECRET_PROMPT {"service":"openai","field":"api_key","label":"OpenAI API Key","purpose":"Generate text embeddings","allowedDomains":["api.openai.com"],"allowedTools":["search"]}
We need this to continue.`;

    const parsed = parseSecretPrompt(raw);
    expect(parsed).toEqual({
      id: "openai:api_key",
      service: "openai",
      field: "api_key",
      label: "OpenAI API Key",
      description: undefined,
      placeholder: undefined,
      purpose: "Generate text embeddings",
      allowedDomains: ["api.openai.com"],
      allowedTools: ["search"],
    });
  });

  it("parses <secret_prompt ... /> XML tag format", () => {
    const raw = `<secret_prompt service="github" field="token" label="GitHub Token" purpose="Access private repo" />`;
    const parsed = parseSecretPrompt(raw);

    expect(parsed).toEqual({
      id: "github:token",
      service: "github",
      field: "token",
      label: "GitHub Token",
      description: undefined,
      placeholder: undefined,
      purpose: "Access private repo",
      allowedDomains: undefined,
      allowedTools: undefined,
    });
  });

  it("parses <secret_prompt> JSON body format", () => {
    const raw = `<secret_prompt>
      {"service":"stripe","field":"secret_key","label":"Stripe Secret","purpose":"Process refunds"}
    </secret_prompt>`;
    const parsed = parseSecretPrompt(raw);

    expect(parsed).toEqual({
      id: "stripe:secret_key",
      service: "stripe",
      field: "secret_key",
      label: "Stripe Secret",
      description: undefined,
      placeholder: undefined,
      purpose: "Process refunds",
      allowedDomains: undefined,
      allowedTools: undefined,
    });
  });

  it("parses direct object with type: 'secret_prompt'", () => {
    const obj = {
      type: "secret_prompt",
      service: "anthropic",
      field: "api_key",
      label: "Anthropic Claude Key",
      description: "Enter your Anthropic Claude API Key",
      placeholder: "sk-ant-...",
      allowedDomains: ["api.anthropic.com"],
    };

    const parsed = parseSecretPrompt(obj);
    expect(parsed).toEqual({
      id: "anthropic:api_key",
      service: "anthropic",
      field: "api_key",
      label: "Anthropic Claude Key",
      description: "Enter your Anthropic Claude API Key",
      placeholder: "sk-ant-...",
      purpose: undefined,
      allowedDomains: ["api.anthropic.com"],
      allowedTools: undefined,
    });
  });

  it("parses tool call object for request_credential or credential_prompt", () => {
    const toolCall = {
      tool: "request_credential",
      input: {
        service: "aws",
        field: "access_key_id",
        label: "AWS Access Key ID",
        purpose: "S3 backup",
      },
    };

    const parsed = parseSecretPrompt(toolCall);
    expect(parsed).toEqual({
      id: "aws:access_key_id",
      service: "aws",
      field: "access_key_id",
      label: "AWS Access Key ID",
      description: undefined,
      placeholder: undefined,
      purpose: "S3 backup",
      allowedDomains: undefined,
      allowedTools: undefined,
    });
  });

  it("parses applet view structure", () => {
    const appletCall = {
      name: "applet",
      input: {
        view: {
          type: "secret_prompt",
          service: "slack_channel",
          field: "bot_token",
          label: "Slack Bot Token",
          purpose: "Post deployment updates",
          allowedTools: ["slack_post_message"],
        },
      },
    };

    const parsed = parseSecretPrompt(appletCall);
    expect(parsed).toEqual({
      id: "slack_channel:bot_token",
      service: "slack_channel",
      field: "bot_token",
      label: "Slack Bot Token",
      description: undefined,
      placeholder: undefined,
      purpose: "Post deployment updates",
      allowedDomains: undefined,
      allowedTools: ["slack_post_message"],
    });
  });

  it("returns null for invalid or unrelated inputs", () => {
    expect(parseSecretPrompt(null)).toBeNull();
    expect(parseSecretPrompt(undefined)).toBeNull();
    expect(parseSecretPrompt("Just normal assistant speech")).toBeNull();
    expect(parseSecretPrompt({ some: "other object" })).toBeNull();
    expect(parseSecretPrompt({ service: "only_service" })).toBeNull();
  });
});

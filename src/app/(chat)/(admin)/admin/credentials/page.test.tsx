import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { CredentialMetadata } from "@/lib/backend/credentials-api";
import AdminCredentialsPage, {
  AgentUsageDetails,
  CredentialRow,
  filterCredentials,
  validateCredentialDraft,
} from "./page";

function credential(
  overrides: Partial<CredentialMetadata> = {},
): CredentialMetadata {
  return {
    id: "github/token",
    service: "github",
    field: "token",
    label: "GitHub Personal Access Token",
    hint: "••••1234",
    envVar: "AMIRO_CRED_GITHUB_TOKEN",
    usageDescription: "Use for GitHub API interactions",
    allowedDomains: ["api.github.com"],
    updatedAt: "2026-10-18T00:00:00.000Z",
    ...overrides,
  };
}

describe("filterCredentials", () => {
  it("returns every credential for a blank query", () => {
    const items = [credential(), credential({ id: "openai/api_key" })];
    expect(filterCredentials(items, "   ")).toEqual(items);
  });

  it("matches service, label, hint, env var, and allowed domains", () => {
    const items = [
      credential(),
      credential({
        id: "stripe/secret_key",
        service: "stripe",
        field: "secret_key",
        label: "Billing",
        hint: "••••9999",
        envVar: "AMIRO_CRED_STRIPE_SECRET_KEY",
        usageDescription: "Use for Stripe billing",
        allowedDomains: ["api.stripe.com"],
      }),
    ];

    expect(filterCredentials(items, "github")).toEqual([items[0]]);
    expect(filterCredentials(items, "billing")).toEqual([items[1]]);
    expect(filterCredentials(items, "9999")).toEqual([items[1]]);
    expect(filterCredentials(items, "AMIRO_CRED_GITHUB_TOKEN")).toEqual([
      items[0],
    ]);
    expect(filterCredentials(items, "api.stripe.com")).toEqual([items[1]]);
    expect(filterCredentials(items, "does-not-exist")).toEqual([]);
  });
});

describe("validateCredentialDraft", () => {
  it("requires service, field, and secret value", () => {
    expect(
      validateCredentialDraft({ service: "", field: "token", value: "x" }),
    ).toBe("Service name is required");
    expect(
      validateCredentialDraft({ service: "github", field: "", value: "x" }),
    ).toBe("Field name is required");
    expect(
      validateCredentialDraft({ service: "github", field: "token", value: "  " }),
    ).toBe("Secret value is required");
    expect(
      validateCredentialDraft({
        service: "github",
        field: "token",
        value: "secret",
      }),
    ).toBeNull();
  });
});

describe("CredentialRow", () => {
  it("renders masked metadata and accessible actions without the secret", () => {
    const html = renderToStaticMarkup(
      createElement(CredentialRow, {
        credential: credential(),
        copied: false,
        deleting: false,
        onCopyEnv: () => {},
        onDelete: () => {},
      }),
    );

    expect(html).toContain('data-testid="credential-row-github-token"');
    expect(html).toContain("GitHub Personal Access Token");
    expect(html).toContain("github/token");
    expect(html).toContain("••••1234");
    expect(html).toContain("data-private");
    expect(html).toContain("$AMIRO_CRED_GITHUB_TOKEN");
    expect(html).toContain('aria-label="Copy environment variable');
    expect(html).toContain('aria-label="Delete github/token"');
    expect(html).toContain("api.github.com");
    expect(html).not.toContain("ghp_");
  });

  it("disables the delete action while a deletion is in flight", () => {
    const html = renderToStaticMarkup(
      createElement(CredentialRow, {
        credential: credential(),
        copied: false,
        deleting: true,
        onCopyEnv: () => {},
        onDelete: () => {},
      }),
    );

    expect(html).toContain("disabled");
    expect(html).toContain("animate-spin");
  });
});

describe("AgentUsageDetails", () => {
  it("keeps the technical guide collapsed behind native details", () => {
    const html = renderToStaticMarkup(createElement(AgentUsageDetails));

    expect(html).toContain("<details");
    expect(html).toContain("<summary");
    expect(html).toContain("How agents use credentials");
    expect(html).toContain("$AMIRO_CRED_");
    expect(html).not.toContain("credentials-agent-guide-card");
    expect(html).not.toContain("Zero-Plaintext");
  });
});

describe("AdminCredentialsPage", () => {
  it("leads with a short header and no upfront architecture guide", () => {
    const html = renderToStaticMarkup(createElement(AdminCredentialsPage));

    expect(html).toContain(">Credentials<");
    expect(html).toContain("Encrypted secrets your agents can use");
    expect(html).toContain('data-testid="credentials-add-button"');
    expect(html).toContain('data-testid="credentials-list"');
    expect(html).toContain("How agents use credentials");
    expect(html).not.toContain("credentials-agent-guide-card");
    expect(html).not.toContain("Zero-Plaintext");
  });
});

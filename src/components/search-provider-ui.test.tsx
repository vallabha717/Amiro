import type {
  SearchProviderConfig,
  SearchProviderSpec,
} from "@/lib/backend/search-provider-api";
import { type ComponentProps, createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  providers: [] as SearchProviderConfig[],
  catalog: [] as SearchProviderSpec[],
  error: undefined as Error | undefined,
  mutate: vi.fn(),
  push: vi.fn(),
  save: vi.fn(),
  activate: vi.fn(),
  buttons: [] as Array<ComponentProps<"button">>,
}));
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: mocks.push }) }));
vi.mock("next/dynamic", () => ({ default: () => () => null }));
vi.mock("next-intl", () => ({ useTranslations: () => (key: string) => key }));
vi.mock("swr", () => ({
  default: (key: string) => ({
    data: key.endsWith("catalog") ? mocks.catalog : mocks.providers,
    isLoading: false,
    isValidating: false,
    error: key.endsWith("providers") ? mocks.error : undefined,
    mutate: mocks.mutate,
  }),
  useSWRConfig: () => ({ mutate: mocks.mutate }),
  mutate: mocks.mutate,
}));
vi.mock("@/lib/backend/search-provider-api", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  saveSearchProvider: mocks.save,
  activateSearchProvider: mocks.activate,
}));
vi.mock("ui/shared-toast", () => ({ handleErrorWithToast: vi.fn() }));
vi.mock("ui/button", () => ({
  Button: (props: ComponentProps<"button">) => {
    mocks.buttons.push(props);
    return createElement("button", props);
  },
}));
vi.mock("ui/tooltip", () => ({
  Tooltip: ({ children }: { children: React.ReactNode }) => children,
  TooltipTrigger: ({ children }: { children: React.ReactNode }) => children,
  TooltipContent: ({ children }: { children: React.ReactNode }) => children,
}));

import AdminSearchProvidersPage from "@/app/(chat)/(admin)/admin/search/page";
import { SearchProviderCard } from "./search-provider-card";
import SearchProviderEditor from "./search-provider-editor";

const freeSpec: SearchProviderSpec = {
  kind: "duckduckgo",
  label: "DuckDuckGo",
  extracts: false,
  freeTier: "Free",
  docs: "https://duckduckgo.com",
  keyless: true,
};
const provider: SearchProviderConfig = {
  id: "free",
  name: "Free Search",
  provider: "duckduckgo",
  configured: true,
  isActive: true,
  extracts: false,
};

beforeEach(() => {
  vi.clearAllMocks();
  mocks.providers = [provider];
  mocks.catalog = [freeSpec];
  mocks.error = undefined;
  mocks.buttons = [];
});

describe("search provider management", () => {
  it("describes native default as supported-model hosted search", () => {
    const html = renderToStaticMarkup(
      createElement(SearchProviderCard, { ...provider, provider: "native" }),
    );
    expect(html).toContain("Uses model-native search when supported");
    expect(html).toContain(
      "Configured local providers remain available if it fails",
    );
    expect(html).not.toContain("Tried first for every search");
  });

  it("does not promise native hosted search as an automatic fallback", () => {
    const html = renderToStaticMarkup(
      createElement(SearchProviderCard, {
        ...provider,
        provider: "native",
        isActive: false,
      }),
    );
    expect(html).toContain("Hosted search available when selected as default");
    expect(html).toContain("Not an automatic HTTP fallback");
    expect(html).not.toContain("fallback if the default provider fails");
  });

  it("excludes non-default native search from automatic fallback counts", () => {
    mocks.providers = [
      provider,
      { ...provider, id: "native", provider: "native", isActive: false },
      { ...provider, id: "bing", provider: "bing", isActive: false },
    ];
    const html = renderToStaticMarkup(createElement(AdminSearchProvidersPage));
    expect(html).toContain("3 configured");
    expect(html).toContain("1 fallback");
    expect(html).not.toContain("2 fallbacks");
  });

  it("labels the selected configured provider as default without a missing-key warning", () => {
    const html = renderToStaticMarkup(
      createElement(SearchProviderCard, { ...provider, spec: freeSpec }),
    );
    expect(html).toContain("Default");
    expect(html).toContain("Tried first for every search");
    expect(html).toContain("No API key required");
    expect(html).not.toContain("No API key stored");
    expect(html).not.toContain("search-provider-default-button");
  });

  it("labels configured alternatives as fallbacks with an accessible default action", () => {
    const html = renderToStaticMarkup(
      createElement(SearchProviderCard, {
        ...provider,
        isActive: false,
        spec: freeSpec,
      }),
    );
    expect(html).toContain("Fallback");
    expect(html).toContain('aria-label="Set Free Search as default"');
    expect(html).toContain("fallback if the default provider fails");
  });

  it("does not allow an unconfigured saved provider to become default", () => {
    const html = renderToStaticMarkup(
      createElement(SearchProviderCard, {
        ...provider,
        configured: false,
        isActive: false,
      }),
    );
    expect(html).toContain("Unavailable");
    expect(html).not.toContain("search-provider-default-button");
    expect(html).not.toContain("search-provider-test-link");
  });

  it("sets the default through the existing API and refreshes default hints", async () => {
    renderToStaticMarkup(
      createElement(SearchProviderCard, {
        ...provider,
        isActive: false,
        spec: freeSpec,
      }),
    );
    const button = mocks.buttons.find(
      (p) =>
        (p as Record<string, unknown>)["data-testid"] ===
        "search-provider-default-button",
    );
    await button?.onClick?.({} as React.MouseEvent<HTMLButtonElement>);
    expect(mocks.activate).toHaveBeenCalledWith("free");
    expect(mocks.mutate).toHaveBeenCalledWith("/api/search/providers");
    expect(mocks.mutate).toHaveBeenCalledWith("/api/search/active");
  });

  it("counts only configured providers and configured fallbacks", () => {
    mocks.providers = [
      provider,
      { ...provider, id: "bing", name: "Bing", isActive: false },
      { ...provider, id: "legacy", configured: false, isActive: false },
    ];
    const html = renderToStaticMarkup(createElement(AdminSearchProvidersPage));
    expect(html).toContain("2 configured");
    expect(html).toContain("Default: Free Search");
    expect(html).toContain("1 fallback");
    expect(html).toContain(
      "Only configured providers are available to your agent",
    );
    expect(html).toContain("Provider Native is the default on first setup");
    expect(html).toMatch(/Free DuckDuckGo and\s+Bing/);
    expect(html).toContain("preconfigured as local alternatives");
  });

  it("does not fabricate a default or configured count on a load error", () => {
    mocks.error = new Error("offline");
    const html = renderToStaticMarkup(createElement(AdminSearchProvidersPage));
    expect(html).toContain('role="alert"');
    expect(html).toContain("Search providers could not be loaded");
    expect(html).not.toContain('data-testid="search-provider-counts"');
  });

  it("renders and saves a keyless provider without asking for an API key", async () => {
    const html = renderToStaticMarkup(
      createElement(SearchProviderEditor, { initialConfig: provider }),
    );
    expect(html).toContain("No API key required");
    expect(html).not.toContain("search-provider-key-input");
    expect(html).not.toContain("Get an API key");
    const button = mocks.buttons.find(
      (p) =>
        (p as Record<string, unknown>)["data-testid"] ===
        "search-provider-save-button",
    );
    await button?.onClick?.({} as React.MouseEvent<HTMLButtonElement>);
    expect(mocks.save).toHaveBeenCalledWith(
      expect.objectContaining({ provider: "duckduckgo", apiKey: "" }),
    );
    expect(mocks.mutate).toHaveBeenCalledWith("/api/search/providers");
    expect(mocks.mutate).toHaveBeenCalledWith("/api/search/active");
  });

  it("uses backend API-base metadata for self-hosted keyless providers", async () => {
    mocks.catalog = [
      {
        ...freeSpec,
        kind: "searxng",
        supportsApiBase: true,
        defaultApiBase: "https://search.example.org",
      },
    ];
    renderToStaticMarkup(
      createElement(SearchProviderEditor, {
        initialConfig: {
          ...provider,
          provider: "searxng",
          baseUrl: "https://private.example.org",
        },
      }),
    );
    const button = mocks.buttons.find(
      (p) =>
        (p as Record<string, unknown>)["data-testid"] ===
        "search-provider-save-button",
    );
    await button?.onClick?.({} as React.MouseEvent<HTMLButtonElement>);
    expect(mocks.save).toHaveBeenCalledWith(
      expect.objectContaining({ baseUrl: "https://private.example.org" }),
    );
  });

  it("does not invent custom or other options when the backend catalogue is empty", () => {
    mocks.catalog = [];
    const html = renderToStaticMarkup(
      createElement(SearchProviderEditor, { initialConfig: provider }),
    );
    expect(html).toContain("not supported by the current backend");
    const button = mocks.buttons.find(
      (p) =>
        (p as Record<string, unknown>)["data-testid"] ===
        "search-provider-save-button",
    );
    expect(button?.disabled).toBe(true);
  });

  it("still requires credentials when configuring a paid provider", async () => {
    mocks.catalog = [{ ...freeSpec, kind: "brave", keyless: false }];
    const html = renderToStaticMarkup(
      createElement(SearchProviderEditor, {
        initialConfig: { ...provider, provider: "brave", configured: false },
      }),
    );
    expect(html).toContain("search-provider-key-input");
    const button = mocks.buttons.find(
      (p) =>
        (p as Record<string, unknown>)["data-testid"] ===
        "search-provider-save-button",
    );
    await button?.onClick?.({} as React.MouseEvent<HTMLButtonElement>);
    expect(mocks.save).not.toHaveBeenCalled();
  });
});

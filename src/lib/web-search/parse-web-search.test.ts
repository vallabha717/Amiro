import { describe, expect, it } from "vitest";
import {
  extractDomain,
  faviconUrlFor,
  isSafeHttpUrl,
  parseWebFetchOutput,
  parseWebSearchOutput,
} from "./parse-web-search";

describe("web url helpers", () => {
  it("strips www and returns an empty string for junk", () => {
    expect(extractDomain("https://www.example.com/a/b?c=1")).toBe(
      "example.com",
    );
    expect(extractDomain("https://sub.docs.example.co.uk")).toBe(
      "sub.docs.example.co.uk",
    );
    // No scheme: still resolved via the https:// fallback.
    expect(extractDomain("example.org/path")).toBe("example.org");
    expect(extractDomain("not a url")).toBe("");
    expect(extractDomain("")).toBe("");
  });

  it("builds a Google favicon url only for a resolvable host", () => {
    expect(faviconUrlFor("https://www.example.com/x")).toBe(
      "https://www.google.com/s2/favicons?domain=example.com&sz=64",
    );
    expect(faviconUrlFor("nonsense")).toBe("");
  });

  it("only trusts http(s) urls for links", () => {
    expect(isSafeHttpUrl("https://example.com")).toBe(true);
    expect(isSafeHttpUrl("http://example.com")).toBe(true);
    expect(isSafeHttpUrl("javascript:alert(1)")).toBe(false);
    expect(isSafeHttpUrl("data:text/html,x")).toBe(false);
    expect(isSafeHttpUrl(undefined)).toBe(false);
  });
});

describe("parseWebSearchOutput text formats", () => {
  it("parses the configured-provider format with a fallback line", () => {
    const output = [
      "Search provider: Bing Search (bing)",
      "Search results for: rust async runtime",
      "Fallback after: duckduckgo: empty results",
      "",
      "1. **Tokio - An asynchronous Rust runtime**",
      "   https://tokio.rs/",
      "   Tokio is an asynchronous runtime for Rust.",
      "",
      "2. **async-std**",
      "   https://async.rs/",
      "   Async version of the Rust standard library.",
    ].join("\n");

    const parsed = parseWebSearchOutput(output, "rust async runtime");
    expect(parsed.provider).toBe("Bing Search");
    expect(parsed.providerId).toBe("bing");
    expect(parsed.query).toBe("rust async runtime");
    expect(parsed.fallbackAfter).toBe("duckduckgo: empty results");
    expect(parsed.noResults).toBe(false);
    expect(parsed.hits).toHaveLength(2);

    expect(parsed.hits[0]).toMatchObject({
      rank: 1,
      title: "Tokio - An asynchronous Rust runtime",
      url: "https://tokio.rs/",
      domain: "tokio.rs",
      faviconUrl: "https://www.google.com/s2/favicons?domain=tokio.rs&sz=64",
      snippet: "Tokio is an asynchronous runtime for Rust.",
    });
    expect(parsed.hits[1]!.rank).toBe(2);
    expect(parsed.hits[1]!.title).toBe("async-std");
  });

  it("parses the plain local-engine format (no provider header)", () => {
    const output = [
      "Search results for: example query",
      "",
      "1. **Example Domain**",
      "   https://example.com/",
      "   Illustrative examples in documents.",
    ].join("\n");

    const parsed = parseWebSearchOutput(output, "example query");
    expect(parsed.provider).toBeUndefined();
    expect(parsed.query).toBe("example query");
    expect(parsed.hits).toHaveLength(1);
    expect(parsed.hits[0]!.title).toBe("Example Domain");
    expect(parsed.hits[0]!.domain).toBe("example.com");
  });

  it("parses `Title` + `URL:` blocks", () => {
    const output = [
      "Search results for: q",
      "",
      "1. Example Result",
      "   URL: https://example.org/page",
      "   A short snippet.",
    ].join("\n");

    const parsed = parseWebSearchOutput(output);
    expect(parsed.hits[0]).toMatchObject({
      title: "Example Result",
      url: "https://example.org/page",
      domain: "example.org",
      snippet: "A short snippet.",
    });
  });

  it("parses plain Title / URL pairs (Anthropic style)", () => {
    const output = [
      "The Rust Programming Language",
      "https://www.rust-lang.org/",
      "Tokio",
      "https://tokio.rs/",
    ].join("\n");

    const parsed = parseWebSearchOutput(output, "rust");
    expect(parsed.query).toBe("rust");
    expect(parsed.hits.map((h) => h.title)).toEqual([
      "The Rust Programming Language",
      "Tokio",
    ]);
    expect(parsed.hits[0]!.domain).toBe("rust-lang.org");
  });

  it("parses citation lines and falls back to the domain for a title", () => {
    const parsed = parseWebSearchOutput(
      ["Sources:", "[1] https://docs.rs/tokio", "[2] https://async.rs"].join(
        "\n",
      ),
    );
    expect(parsed.hits).toHaveLength(2);
    expect(parsed.hits[0]).toMatchObject({
      rank: 1,
      url: "https://docs.rs/tokio",
      domain: "docs.rs",
      title: "docs.rs",
    });
  });

  it("de-duplicates hits by url and renumbers ranks densely", () => {
    const output = [
      "Search results for: q",
      "",
      "1. **First**",
      "   https://example.com/a",
      "   one",
      "",
      "2. **Duplicate**",
      "   https://example.com/a",
      "   two",
      "",
      "3. **Third**",
      "   https://example.com/b",
      "   three",
    ].join("\n");

    const parsed = parseWebSearchOutput(output);
    expect(parsed.hits).toHaveLength(2);
    expect(parsed.hits.map((h) => h.rank)).toEqual([1, 2]);
    expect(parsed.hits[1]!.title).toBe("Third");
  });

  it("detects the no-results notice and keeps the query", () => {
    const parsed = parseWebSearchOutput(
      [
        "No results found for: zzz nothing matches",
        "",
        "If results are consistently empty on this machine, the default engines may be blocked.",
      ].join("\n"),
    );
    expect(parsed.noResults).toBe(true);
    expect(parsed.hits).toEqual([]);
    expect(parsed.query).toBe("zzz nothing matches");
    expect(parsed.rawText).toContain("No results found");
  });

  it("strips the tool timing prefix before parsing", () => {
    const raw = [
      "[tool timing: start=2026-10-18T07:46:43.641Z finish=2026-10-18T07:46:50.635Z duration=6.4s] ",
      "Search results for: timed query",
      "",
      "1. **Timed**",
      "   https://timed.example.com/",
      "   snippet",
    ].join("\n");

    const parsed = parseWebSearchOutput(raw);
    expect(parsed.query).toBe("timed query");
    expect(parsed.hits).toHaveLength(1);
    expect(parsed.hits[0]!.title).toBe("Timed");
  });

  it("returns no hits for unrecognized free text, keeping the raw output", () => {
    const parsed = parseWebSearchOutput(
      "something unusual with no links at all",
    );
    expect(parsed.hits).toEqual([]);
    expect(parsed.noResults).toBe(false);
    expect(parsed.rawText).toContain("something unusual");
  });
});

describe("parseWebSearchOutput structured formats", () => {
  it("parses the Go toolkit { provider, results } shape", () => {
    const parsed = parseWebSearchOutput({
      provider: "tavily",
      results: [
        { title: "A", url: "https://a.example.com/x", snippet: "snip a" },
        { title: "B", url: "https://b.example.com/y", snippet: "snip b" },
      ],
    });
    expect(parsed.provider).toBe("tavily");
    expect(parsed.hits).toHaveLength(2);
    expect(parsed.hits[1]).toMatchObject({
      rank: 2,
      title: "B",
      domain: "b.example.com",
      snippet: "snip b",
    });
  });

  it("uses the query header from the payload, else the input query", () => {
    expect(
      parseWebSearchOutput(
        { results: [{ title: "A", url: "https://a.com", snippet: "" }] },
        "input q",
      ).query,
    ).toBe("input q");
    expect(
      parseWebSearchOutput({ query: "payload q", results: [] }).query,
    ).toBe("payload q");
    expect(
      parseWebSearchOutput({ query: "payload q", results: [] }).noResults,
    ).toBe(true);
  });

  it("surfaces a controlled tool error as errorText", () => {
    const parsed = parseWebSearchOutput({
      isError: true,
      error: "no search providers configured",
      solution: "add one in settings",
    });
    expect(parsed.hits).toEqual([]);
    expect(parsed.errorText).toContain("no search providers configured");
    expect(parsed.errorText).toContain("add one in settings");
  });

  it("also accepts extracted pages from webContent as hits", () => {
    const parsed = parseWebSearchOutput({
      provider: "native",
      pages: [{ url: "https://example.com/doc", title: "Doc", text: "body" }],
    });
    expect(parsed.hits[0]).toMatchObject({
      title: "Doc",
      url: "https://example.com/doc",
    });
  });
});

describe("parseWebFetchOutput", () => {
  it("parses the runtime `Fetched <url> (<N> bytes)` header", () => {
    const parsed = parseWebFetchOutput(
      [
        "Fetched https://example.com/docs (12345 bytes)",
        "",
        "# Documentation",
        "",
        "Hello world, this is the page body.",
      ].join("\n"),
    );
    expect(parsed.url).toBe("https://example.com/docs");
    expect(parsed.domain).toBe("example.com");
    expect(parsed.byteCount).toBe(12345);
    expect(parsed.title).toBe("Documentation");
    expect(parsed.content).toContain("Hello world");
    expect(parsed.content).not.toContain("12345 bytes");
  });

  it("parses Final URL / Status / Content markers", () => {
    const parsed = parseWebFetchOutput(
      [
        "Final URL: https://example.com/final",
        "Status: 200 OK",
        "Content:",
        "# Page Title",
        "",
        "Body text.",
      ].join("\n"),
    );
    expect(parsed.url).toBe("https://example.com/final");
    expect(parsed.status).toBe("200 OK");
    expect(parsed.title).toBe("Page Title");
    expect(parsed.content).toContain("Body text.");
    expect(parsed.content).not.toContain("Status:");
  });

  it("extracts a <title> when the page is html", () => {
    const parsed = parseWebFetchOutput(
      [
        "Fetched https://example.com/ (500 bytes)",
        "",
        "<html><head><title>My &amp; Page</title></head><body>hi</body></html>",
      ].join("\n"),
    );
    expect(parsed.title).toBe("My & Page");
  });

  it("falls back to the requested url when the output has no header", () => {
    const parsed = parseWebFetchOutput(
      "just some text",
      "https://example.org/x",
    );
    expect(parsed.url).toBe("https://example.org/x");
    expect(parsed.domain).toBe("example.org");
    expect(parsed.content).toBe("just some text");
    expect(parsed.byteCount).toBeUndefined();
  });

  it("reads structured page output", () => {
    const parsed = parseWebFetchOutput({
      provider: "native",
      pages: [
        {
          url: "https://example.com/a",
          title: "Structured",
          text: "Some extracted body text.",
        },
      ],
    });
    expect(parsed.title).toBe("Structured");
    expect(parsed.url).toBe("https://example.com/a");
    expect(parsed.content).toContain("Some extracted body text.");
  });
});

import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { AgentCharacterAvatar } from "./avatar-primitives";

describe("Agent avatar rendering", () => {
  it("renders a visible SVG even for legacy round eyes", () => {
    const html = renderToStaticMarkup(
      createElement(AgentCharacterAvatar, {
        traits: { bodyShape: "blob", eyeStyle: "round", color: "orange" },
        size: 82,
        animated: false,
      }),
    );
    expect(html).toContain("<svg");
    expect(html).toContain("<path");
    expect(html).toContain('width="82"');
  });
  it("keeps exactly one body path and draws the rest as dots", () => {
    for (const size of [22, 82, 236]) {
      const html = renderToStaticMarkup(
        createElement(AgentCharacterAvatar, {
          size,
          animated: false,
        }),
      );
      // `svg[width="82"] > path` is asserted by adapter/test/agent-browser.mjs,
      // and the hero avatar is checked at width 236.
      const svg = html.match(/<svg[^>]*>([\s\S]*)<\/svg>/)?.[1] ?? "";
      let depth = 0;
      let directPaths = 0;
      for (const match of svg.matchAll(/<(\/?)([a-zA-Z]+)\b[^>]*?(\/?)>/g)) {
        if (match[1] === "/") {
          depth -= 1;
          continue;
        }
        if (depth === 0 && match[2] === "path") {
          directPaths += 1;
        }
        if (match[3] !== "/") {
          depth += 1;
        }
      }
      expect(directPaths, `size ${size} direct path count`).toBe(1);
      expect(html).toContain("<circle");
    }
  });
  it("renders a custom image with an accessible alternative", () => {
    const html = renderToStaticMarkup(
      createElement(AgentCharacterAvatar, {
        customImageUrl: "data:image/png;base64,aGVsbG8=",
        animated: false,
      }),
    );
    expect(html).toContain('alt="Agent avatar"');
    expect(html).toContain("data:image/png;base64,");
  });
});

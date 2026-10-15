import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
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

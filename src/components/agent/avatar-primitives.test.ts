import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { AgentCharacterAvatar } from "./avatar-primitives";

const render = (
  props: Parameters<typeof AgentCharacterAvatar>[0],
): string => renderToStaticMarkup(createElement(AgentCharacterAvatar, props));

describe("Agent avatar rendering", () => {
  it("renders a single OpenDots plush SVG at the requested size", () => {
    const html = render({
      traits: { bodyShape: "blob", eyeStyle: "round", color: "orange" },
      size: 82,
      animated: false,
    });
    expect(html).toContain("<svg");
    expect(html).toContain('width="82"');
    expect(html).toContain('data-testid="agent-avatar"');
    expect(html).toContain('role="img"');
    // The plush sprite is drawn as an <image>, no more traced <path> body.
    expect(html).toContain('href="/agent/opendots/blue.png"');
    expect(html).toContain("<image");
    expect(html).not.toContain("<path");
  });

  it("maps every persisted body id onto a plush variant", () => {
    const cases: Array<[string, string]> = [
      ["blob", "/agent/opendots/blue.png"],
      ["urchin", "/agent/opendots/blue.png"],
      ["ghost", "/agent/opendots/blue.png"],
      ["sprout", "/agent/opendots/mint.png"],
      ["star", "/agent/opendots/orange.png"],
      ["cloud", "/agent/opendots/purple.png"],
      ["unknown-legacy-id", "/agent/opendots/blue.png"],
    ];
    for (const [bodyShape, src] of cases) {
      const html = render({ traits: { bodyShape, eyeStyle: "round", color: "orange" } });
      expect(html, bodyShape).toContain(`href="${src}"`);
    }
  });

  it("desaturates the sprite and tints it with the theme accent", () => {
    const html = render({ animated: false });
    // Grayscale filter step, isolated so the sprite's hue does not leak in.
    expect(html).toContain("<filter");
    expect(html).toContain('type="saturate"');
    expect(html).toContain('values="0"');
    // Tint defaults to the sidebar-primary token and is alpha-masked to the sprite.
    expect(html).toContain('fill="var(--sidebar-primary)"');
    expect(html).toContain("mix-blend-mode:color");
    expect(html).toContain('mask-type="alpha"');
    expect(html).toContain("<mask");
  });

  it("honours an explicit accentColor preview", () => {
    const html = render({ animated: false, accentColor: "#ff8800" });
    expect(html).toContain('fill="#ff8800"');
  });

  it("renders a custom image with an accessible alternative", () => {
    const html = render({
      customImageUrl: "data:image/png;base64,aGVsbG8=",
      animated: false,
    });
    expect(html).toContain('alt="Agent avatar"');
    expect(html).toContain('data-testid="agent-avatar"');
    expect(html).toContain("data:image/png;base64,");
  });
});

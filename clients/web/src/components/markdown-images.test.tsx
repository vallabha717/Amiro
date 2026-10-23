import { renderToStaticMarkup } from "react-dom/server";
import { expect, it } from "vitest";
import { Markdown } from "./markdown";

const url = `data:image/png;base64,${"iVBORw0KGgo".repeat(6)}AAAA==`;
it("renders a bare data URL paragraph as an image", () => {
  const html = renderToStaticMarkup(<Markdown>{"```python\nprint('x')\n```\n\n" + url}</Markdown>);
  expect(html).toContain(`<img src="${url}"`);
  expect(html).toContain("print(");
});
it("keeps a still-streaming block raw", () => {
  const html = renderToStaticMarkup(<Markdown isStreaming>{url}</Markdown>);
  expect(html).not.toContain("<img");
});
it("does not let an svg data URL through", () => {
  const html = renderToStaticMarkup(<Markdown>{"![x](data:image/svg+xml;base64,PHN2Zz4=)"}</Markdown>);
  expect(html).not.toContain("data:image/svg");
});

import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { FilesTabView } from "./files-tab-view";
import type { TodoArtifact } from "./use-artifacts";

vi.mock("./todo-panel", () => ({
  TodoPanel: () => createElement("div", { "data-testid": "mock-todos" }),
}));

vi.mock("./file-artifacts", () => ({
  FileArtifactsPanel: () =>
    createElement("div", { "data-testid": "mock-files" }),
  useOpenArtifactFile: () => () => {},
}));

const todos: TodoArtifact = {
  items: [
    { content: "write the doc", status: "done" },
    { content: "ship it", status: "in_progress" },
  ],
  done: 1,
  inProgress: 1,
  pending: 0,
  live: false,
};

describe("FilesTabView", () => {
  it("shows the task list above the files once the agent wrote one", () => {
    const html = renderToStaticMarkup(
      createElement(FilesTabView, { todos: { ...todos } }),
    );
    expect(html).toContain('data-testid="mock-todos"');
    expect(html).toContain('data-testid="mock-files"');
    expect(html.indexOf("mock-todos")).toBeLessThan(html.indexOf("mock-files"));
  });

  it("shows only files when the turn wrote no tasks", () => {
    for (const value of [undefined, { ...todos, items: [] }]) {
      const html = renderToStaticMarkup(
        createElement(FilesTabView, { todos: value as never }),
      );
      expect(html).not.toContain("mock-todos");
      expect(html).toContain('data-testid="mock-files"');
    }
  });
});

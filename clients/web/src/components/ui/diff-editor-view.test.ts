import { describe, expect, it } from "vitest";
import {
  type DiffRow,
  buildDiffRows,
  charDiff,
  collapseRows,
  lineDiff,
  sectionsFromEditOutput,
} from "./diff-editor-view";

describe("lineDiff", () => {
  it("keeps a shared middle line as equal rather than deleting and re-inserting it", () => {
    expect(lineDiff(["a", "shared", "b"], ["x", "shared", "y"])).toEqual([
      { type: "delete", text: "a" },
      { type: "insert", text: "x" },
      { type: "equal", text: "shared" },
      { type: "delete", text: "b" },
      { type: "insert", text: "y" },
    ]);
  });

  it("is a pure insert when nothing is removed", () => {
    expect(lineDiff([], ["new"])).toEqual([{ type: "insert", text: "new" }]);
  });

  it("is a pure delete when nothing is added", () => {
    expect(lineDiff(["old"], [])).toEqual([{ type: "delete", text: "old" }]);
  });

  it("is all equal for identical blocks", () => {
    expect(lineDiff(["a", "b"], ["a", "b"])).toEqual([
      { type: "equal", text: "a" },
      { type: "equal", text: "b" },
    ]);
  });
});

describe("charDiff", () => {
  it("isolates a renamed identifier inside an otherwise unchanged line", () => {
    const { a, b } = charDiff("return oldName + 1", "return newName + 1");
    expect(a).toEqual([
      { text: "return ", changed: false },
      { text: "old", changed: true },
      { text: "Name + 1", changed: false },
    ]);
    expect(b).toEqual([
      { text: "return ", changed: false },
      { text: "new", changed: true },
      { text: "Name + 1", changed: false },
    ]);
  });

  it("marks a wholly different line as one changed segment", () => {
    expect(charDiff("foo", "bar").a).toEqual([{ text: "foo", changed: true }]);
  });

  it("does not let the common prefix and suffix overlap on a short pair", () => {
    // "a" vs "aa": the prefix scan claims the "a", and the suffix scan must
    // not claim that same "a" again -- double-counting slices past the string.
    const { a, b } = charDiff("a", "aa");
    expect(a.map((s) => s.text).join("")).toBe("a");
    expect(b.map((s) => s.text).join("")).toBe("aa");
  });
});

describe("buildDiffRows", () => {
  it("numbers both gutters from the section's own start line", () => {
    const rows = buildDiffRows("a\nb", "a\nB", 40);
    expect(rows.map((r) => [r.leftNo, r.rightNo])).toEqual([
      [40, 40],
      [41, 41],
    ]);
  });

  it("pairs a replaced line side by side with its changed part highlighted", () => {
    const rows = buildDiffRows("const x = oldValue", "const x = newValue");
    expect(rows).toHaveLength(1);
    expect(rows[0].changed).toBe(true);
    expect(rows[0].left).toMatchObject({ tone: "removed" });
    expect(rows[0].right).toMatchObject({ tone: "added" });
    expect(rows[0].left?.segments?.some((s) => s.changed)).toBe(true);
  });

  // Both panes render from this one list, so a row with a hole on one side is
  // exactly what keeps the two columns on the same line.
  it("leaves a blank filler cell on the shorter side, with no line number", () => {
    expect(buildDiffRows("one", "one\ntwo")).toEqual([
      {
        left: { text: "one", tone: "context" },
        right: { text: "one", tone: "context" },
        leftNo: 1,
        rightNo: 1,
        changed: false,
      },
      {
        left: null,
        right: { text: "two", tone: "added" },
        leftNo: null,
        rightNo: 2,
        changed: true,
      },
    ]);
  });

  it("renders a pure deletion with nothing on the added side", () => {
    expect(buildDiffRows("gone", "")).toEqual([
      {
        left: { text: "gone", tone: "removed" },
        right: null,
        leftNo: 1,
        rightNo: null,
        changed: true,
      },
    ]);
  });

  it("ignores the empty string a trailing newline leaves behind", () => {
    expect(buildDiffRows("a\n", "a\n")).toHaveLength(1);
  });

  it("produces nothing for two empty sides", () => {
    expect(buildDiffRows("", "")).toEqual([]);
  });
});

describe("collapseRows", () => {
  const row = (changed: boolean, text = "x"): DiffRow => ({
    left: { text, tone: changed ? "removed" : "context" },
    right: { text, tone: changed ? "added" : "context" },
    leftNo: 1,
    rightNo: 1,
    changed,
  });

  // The whole reason a full-file diff is usable: a long untouched stretch
  // folds away instead of demanding you scroll past it to find the change.
  it("folds a long unchanged run, keeping context on both sides of the change", () => {
    const rows = [
      row(true),
      ...Array.from({ length: 30 }, () => row(false)),
      row(true),
    ];
    const blocks = collapseRows(rows, 3);
    expect(blocks.map((b) => b.kind)).toEqual(["rows", "gap", "rows"]);
    // 3 lines of context kept each side, so 30 - 6 are hidden.
    expect(blocks[1].rows).toHaveLength(24);
  });

  it("leaves a short run alone rather than trading lines for a band", () => {
    const rows = [row(true), row(false), row(false), row(true)];
    expect(collapseRows(rows, 3).map((b) => b.kind)).toEqual(["rows"]);
  });

  // There is no change above the first run to give context to, so none is
  // reserved -- otherwise a file opening with 200 untouched lines would show
  // three of them for no reason.
  it("keeps no leading context above the very first run", () => {
    const rows = [...Array.from({ length: 20 }, () => row(false)), row(true)];
    const blocks = collapseRows(rows, 3);
    expect(blocks[0].kind).toBe("gap");
    expect(blocks[0].rows).toHaveLength(17);
  });

  it("returns a single block when everything changed", () => {
    expect(collapseRows([row(true), row(true)]).map((b) => b.kind)).toEqual([
      "rows",
    ]);
  });
});

describe("sectionsFromEditOutput", () => {
  it("prefers the whole-file view the backend ships for this diff", () => {
    expect(
      sectionsFromEditOutput({
        ui_view: { before: "a\nb", after: "a\nc", start_line: 1 },
        edits: [{ at_line: 2, hunk: ["-b", "+c"] }],
      }),
    ).toEqual({
      sections: [{ before: "a\nb", after: "a\nc", startLine: 1 }],
      windowed: false,
    });
  });

  it("reports a windowed view as partial, so its gutter is not read as the whole file", () => {
    const { windowed, sections } = sectionsFromEditOutput({
      ui_view: { before: "x", after: "y", start_line: 900, windowed: true },
    });
    expect(windowed).toBe(true);
    expect(sections[0].startLine).toBe(900);
  });

  // Messages persisted before the backend sent ui_view. Rendering their
  // fragments beats showing an old thread nothing at all.
  it("falls back to the hunk preview on messages that predate the full view", () => {
    expect(
      sectionsFromEditOutput({
        edits: [{ at_line: 12, hunk: ["-old one", "-old two", "+new"] }],
      }),
    ).toEqual({
      sections: [{ before: "old one\nold two", after: "new", startLine: 12 }],
      windowed: true,
    });
  });

  it("produces nothing renderable from an output with neither", () => {
    expect(sectionsFromEditOutput({})).toEqual({
      sections: [],
      windowed: false,
    });
    expect(sectionsFromEditOutput(undefined)).toEqual({
      sections: [],
      windowed: false,
    });
  });
});

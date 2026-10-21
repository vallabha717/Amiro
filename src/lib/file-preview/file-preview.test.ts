import JSZip from "jszip";
import { describe, expect, it } from "vitest";
import { previewKindOf, workspacePathFrom, previewByteCap } from "./kinds";
import { parseDelimited, readPptx, readXlsx } from "./office";

describe("previewKindOf", () => {
  it.each([
    ["a.PDF", "pdf"],
    ["deck.pptx", "pptx"],
    ["notes.docx", "docx"],
    ["book.xlsx", "xlsx"],
    ["clip.mp4", "video"],
    ["song.mp3", "audio"],
    ["pic.jpeg", "image"],
    ["data.csv", "csv"],
    ["README.md", "markdown"],
    ["main.rs", "code"],
    ["archive.zip", "unsupported"],
    ["Makefile", "unsupported"],
  ])("%s -> %s", (name, kind) => expect(previewKindOf(name)).toBe(kind));

  it("gives media larger caps than text", () => {
    expect(previewByteCap("video")).toBeGreaterThan(previewByteCap("pdf"));
    expect(previewByteCap("pdf")).toBeGreaterThan(previewByteCap("docx"));
  });
});

describe("workspacePathFrom", () => {
  it("keeps relative paths", () => {
    expect(workspacePathFrom("out/report.pdf")).toBe("out/report.pdf");
    expect(workspacePathFrom("./notes.md")).toBe("notes.md");
    expect(workspacePathFrom("`deck.pptx`")).toBe("deck.pptx");
  });
  it("strips everything up to the workspace folder", () => {
    expect(workspacePathFrom("~/.amiro/workspace/out/a.docx")).toBe("out/a.docx");
    expect(workspacePathFrom("/home/me/.amiro/workspace/a/b.mp4")).toBe("a/b.mp4");
  });
  it("rejects things that are not workspace files", () => {
    expect(workspacePathFrom("/etc/passwd.txt")).toBeNull();
    expect(workspacePathFrom("../secret.txt")).toBeNull();
    expect(workspacePathFrom("https://x.com/a.pdf")).toBeNull();
    expect(workspacePathFrom("v1.2")).toBeNull();
    expect(workspacePathFrom("useState")).toBeNull();
    expect(workspacePathFrom("a b  c.txt")).toBeNull();
  });
});

describe("parseDelimited", () => {
  it("handles quotes, commas and CRLF", () => {
    expect(parseDelimited('a,"b,c","d ""q"""\r\n1,2,3')).toEqual([
      ["a", "b,c", 'd "q"'],
      ["1", "2", "3"],
    ]);
  });
});

async function zipBlob(files: Record<string, string>): Promise<Blob> {
  const zip = new JSZip();
  for (const [name, body] of Object.entries(files)) zip.file(name, body);
  return zip.generateAsync({ type: "blob" });
}

describe("office readers", () => {
  it("reads slide titles, lines and notes from a pptx", async () => {
    const slide = (t: string, b: string) =>
      `<p:sld xmlns:a="a" xmlns:p="p"><a:p><a:r><a:t>${t}</a:t></a:r></a:p><a:p><a:r><a:t>${b}</a:t></a:r></a:p></p:sld>`;
    const blob = await zipBlob({
      "ppt/slides/slide2.xml": slide("Second", "two"),
      "ppt/slides/slide1.xml": slide("First", "one"),
      "ppt/notesSlides/notesSlide1.xml": `<p:notes xmlns:a="a" xmlns:p="p"><a:p><a:r><a:t>say hi</a:t></a:r></a:p></p:notes>`,
    });
    const slides = await readPptx(blob);
    expect(slides.map((s) => s.title)).toEqual(["First", "Second"]);
    expect(slides[0].lines).toEqual(["one"]);
    expect(slides[0].notes).toEqual(["say hi"]);
  });

  it("reads cells from an xlsx, resolving shared strings", async () => {
    const blob = await zipBlob({
      "xl/workbook.xml": `<workbook xmlns:r="r"><sheets><sheet name="Data" r:id="rId1"/></sheets></workbook>`,
      "xl/_rels/workbook.xml.rels": `<Relationships><Relationship Id="rId1" Target="worksheets/sheet1.xml"/></Relationships>`,
      "xl/sharedStrings.xml": `<sst><si><t>Name</t></si><si><t>Ada</t></si></sst>`,
      "xl/worksheets/sheet1.xml": `<worksheet><sheetData><row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1"><v>Age</v></c></row><row r="2"><c r="A2" t="s"><v>1</v></c><c r="C2"><v>36</v></c></row></sheetData></worksheet>`,
    });
    const [sheet] = await readXlsx(blob);
    expect(sheet.name).toBe("Data");
    expect(sheet.rows[0]).toEqual(["Name", "Age"]);
    expect(sheet.rows[1]).toEqual(["Ada", "", "36"]);
  });
});

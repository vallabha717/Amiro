import JSZip from "jszip";

/** Bytes of a blob, read the way every runtime (and jsdom) understands. */
async function blobBytes(blob: Blob): Promise<ArrayBuffer> {
  if (typeof blob.arrayBuffer === "function") return blob.arrayBuffer();
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as ArrayBuffer);
    reader.onerror = () => reject(reader.error);
    reader.readAsArrayBuffer(blob);
  });
}

const ENTITIES: Record<string, string> = {
  "&amp;": "&",
  "&lt;": "<",
  "&gt;": ">",
  "&quot;": '"',
  "&apos;": "'",
};

function unescapeXml(text: string): string {
  return text
    .replace(/&(amp|lt|gt|quot|apos);/g, (m) => ENTITIES[m] ?? m)
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)));
}

/** Text of every `<tag>` (any namespace prefix) in `xml`, entities decoded. */
function allText(xml: string, tag: string): string[] {
  const re = new RegExp(`<(?:[\\w]+:)?${tag}(?:\\s[^>]*)?>([\\s\\S]*?)</(?:[\\w]+:)?${tag}>`, "g");
  return Array.from(xml.matchAll(re), (m) => unescapeXml(m[1]));
}

/** Inner XML of every `<tag>` element. */
function blocks(xml: string, tag: string): string[] {
  const re = new RegExp(`<(?:[\\w]+:)?${tag}(?:\\s[^>]*)?>([\\s\\S]*?)</(?:[\\w]+:)?${tag}>`, "g");
  return Array.from(xml.matchAll(re), (m) => m[1]);
}

function attr(xmlOpenTag: string, name: string): string {
  return xmlOpenTag.match(new RegExp(`\\s${name}="([^"]*)"`))?.[1] ?? "";
}

function paragraphs(xml: string): string[] {
  return blocks(xml, "p")
    .map((p) => allText(p, "t").join("").trim())
    .filter(Boolean);
}

export interface PptxSlide {
  index: number;
  title: string;
  lines: string[];
  notes: string[];
}

const numberIn = (name: string) => Number(name.match(/(\d+)\.xml$/)?.[1] ?? 0);

/** Slide text from a .pptx: titles, body lines and speaker notes. */
export async function readPptx(blob: Blob): Promise<PptxSlide[]> {
  const zip = await JSZip.loadAsync(await blobBytes(blob));
  const slideFiles = Object.keys(zip.files)
    .filter((n) => /^ppt\/slides\/slide\d+\.xml$/.test(n))
    .sort((a, b) => numberIn(a) - numberIn(b));
  const slides: PptxSlide[] = [];
  for (const [i, name] of slideFiles.entries()) {
    const lines = paragraphs(await zip.file(name)!.async("string"));
    const notesFile = zip.file(`ppt/notesSlides/notesSlide${numberIn(name)}.xml`);
    const notes = notesFile ? paragraphs(await notesFile.async("string")) : [];
    slides.push({
      index: i + 1,
      title: lines[0] ?? `Slide ${i + 1}`,
      lines: lines.slice(1),
      notes: notes.filter((n) => !/^\d+$/.test(n)),
    });
  }
  return slides;
}

export interface Sheet {
  name: string;
  rows: string[][];
  truncated: boolean;
}

const MAX_ROWS = 2000;
const MAX_COLS = 60;

function colIndex(ref: string): number {
  const letters = ref.replace(/[^A-Z]/gi, "").toUpperCase();
  let n = 0;
  for (const ch of letters) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n - 1;
}

/** Cell values from a .xlsx (first rows of every sheet, shared strings resolved). */
export async function readXlsx(blob: Blob): Promise<Sheet[]> {
  const zip = await JSZip.loadAsync(await blobBytes(blob));

  const sharedFile = zip.file("xl/sharedStrings.xml");
  const shared = sharedFile
    ? blocks(await sharedFile.async("string"), "si").map((si) => allText(si, "t").join(""))
    : [];

  const workbook = await zip.file("xl/workbook.xml")!.async("string");
  const relsFile = zip.file("xl/_rels/workbook.xml.rels");
  const rels = new Map<string, string>();
  if (relsFile) {
    for (const m of (await relsFile.async("string")).matchAll(/<Relationship\b[^>]*>/g)) {
      rels.set(attr(m[0], "Id"), attr(m[0], "Target"));
    }
  }

  const sheets: Sheet[] = [];
  const entries = Array.from(workbook.matchAll(/<(?:\w+:)?sheet\b[^>]*>/g), (m) => m[0]);
  for (const [i, tag] of entries.entries()) {
    const target = rels.get(attr(tag, "r:id")) ?? `worksheets/sheet${i + 1}.xml`;
    const path = target.startsWith("/") ? target.slice(1) : `xl/${target.replace(/^\.\//, "")}`;
    const file = zip.file(path);
    if (!file) continue;
    const xml = await file.async("string");
    const rows: string[][] = [];
    let truncated = false;
    for (const rowMatch of xml.matchAll(/<(?:\w+:)?row\b[^>]*>([\s\S]*?)<\/(?:\w+:)?row>/g)) {
      if (rows.length >= MAX_ROWS) {
        truncated = true;
        break;
      }
      const r: string[] = [];
      for (const cell of rowMatch[1].matchAll(/<(?:\w+:)?c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/(?:\w+:)?c>)/g)) {
        const at = colIndex(attr(` ${cell[1]}`, "r"));
        if (at < 0 || at >= MAX_COLS) continue;
        const type = attr(` ${cell[1]}`, "t");
        const body = cell[2] ?? "";
        const v = allText(body, "v")[0] ?? "";
        r[at] = type === "s" ? (shared[Number(v)] ?? "") : type === "inlineStr" ? allText(body, "t").join("") : v;
      }
      rows.push(Array.from(r, (x) => x ?? ""));
    }
    sheets.push({ name: unescapeXml(attr(tag, "name")) || `Sheet ${i + 1}`, rows, truncated });
  }
  return sheets;
}

/** Small RFC 4180 reader: quotes, escaped quotes, and CRLF. */
export function parseDelimited(text: string, delimiter = ","): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"' && text[i + 1] === '"') {
        cell += '"';
        i++;
      } else if (ch === '"') quoted = false;
      else cell += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === delimiter) {
      row.push(cell);
      cell = "";
    } else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && text[i + 1] === "\n") i++;
      row.push(cell);
      rows.push(row);
      row = [];
      cell = "";
    } else cell += ch;
  }
  if (cell !== "" || row.length) {
    row.push(cell);
    rows.push(row);
  }
  return rows;
}

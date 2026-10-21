/**
 * What a file is, for choosing how to preview it. Decided from the name alone
 * so the choice is made before a single byte is fetched.
 */
export type PreviewKind =
  | "image"
  | "video"
  | "audio"
  | "pdf"
  | "docx"
  | "pptx"
  | "xlsx"
  | "csv"
  | "markdown"
  | "html"
  | "json"
  | "code"
  | "text"
  | "unsupported";

const EXT: Record<string, PreviewKind> = {};
const add = (kind: PreviewKind, exts: string[]) =>
  exts.forEach((e) => {
    EXT[e] = kind;
  });

add("image", ["png", "jpg", "jpeg", "gif", "webp", "avif", "bmp", "ico", "svg"]);
add("video", ["mp4", "m4v", "webm", "mov", "ogv"]);
add("audio", ["mp3", "wav", "ogg", "oga", "m4a", "aac", "flac", "opus"]);
add("pdf", ["pdf"]);
add("docx", ["docx"]);
add("pptx", ["pptx"]);
add("xlsx", ["xlsx", "xlsm"]);
add("csv", ["csv", "tsv"]);
add("markdown", ["md", "markdown", "mdx"]);
add("html", ["html", "htm"]);
add("json", ["json", "jsonl"]);
add("text", ["txt", "log", "env", "conf", "cfg", "rtf"]);
add("code", [
  "ts", "tsx", "js", "jsx", "mjs", "cjs", "py", "rs", "go", "java", "c", "h",
  "cpp", "cs", "rb", "php", "sh", "bash", "zsh", "css", "scss", "xml", "yml",
  "yaml", "toml", "sql", "swift", "kt", "lua", "ini", "vue", "svelte",
]);

export function extOf(name: string): string {
  const base = name.slice(name.lastIndexOf("/") + 1);
  const i = base.lastIndexOf(".");
  return i <= 0 ? "" : base.slice(i + 1).toLowerCase();
}

export function previewKindOf(name: string): PreviewKind {
  return EXT[extOf(name)] ?? "unsupported";
}

const MIME: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  avif: "image/avif",
  bmp: "image/bmp",
  ico: "image/x-icon",
  svg: "image/svg+xml",
  mp4: "video/mp4",
  m4v: "video/mp4",
  webm: "video/webm",
  mov: "video/quicktime",
  ogv: "video/ogg",
  mp3: "audio/mpeg",
  wav: "audio/wav",
  ogg: "audio/ogg",
  oga: "audio/ogg",
  m4a: "audio/mp4",
  aac: "audio/aac",
  flac: "audio/flac",
  opus: "audio/ogg",
  pdf: "application/pdf",
};

/** The type a player needs; the server's guess can be generic. */
export function mimeForMedia(name: string, fallback?: string): string {
  return MIME[extOf(name)] ?? fallback ?? "application/octet-stream";
}

/** Kinds that are shown from the raw bytes rather than from decoded text. */
export const BLOB_KINDS: ReadonlySet<PreviewKind> = new Set([
  "image",
  "video",
  "audio",
  "pdf",
  "docx",
  "pptx",
  "xlsx",
]);

const MB = 1024 * 1024;

/** Largest file each reader will open. Past it the viewer offers a download. */
export function previewByteCap(kind: PreviewKind): number {
  switch (kind) {
    case "video":
    case "audio":
      return 500 * MB;
    case "pdf":
    case "image":
      return 100 * MB;
    case "docx":
    case "pptx":
    case "xlsx":
      return 40 * MB;
    default:
      return 10 * MB;
  }
}

/**
 * Turn the path an agent printed into a workspace-relative one, or null when
 * the text is not a file path inside the workspace.
 *
 * Agents write paths several ways: `report.pdf`, `./out/report.pdf`,
 * `~/.amiro/workspace/out/report.pdf`, `/home/me/.amiro/workspace/out/report.pdf`.
 * Only the part after the `workspace/` folder means anything to the backend,
 * which refuses absolute paths on purpose.
 */
export function workspacePathFrom(raw: string): string | null {
  let text = raw.trim().replace(/^["'`(]+|["'`).,;:]+$/g, "");
  if (!text || text.length > 300 || /\s{2,}|[\n\r<>|*?]/.test(text)) return null;
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(text)) return null;
  text = text.replace(/\\/g, "/");
  const marker = text.match(/(?:^|\/)workspace\/(.+)$/);
  if (marker) text = marker[1];
  else if (text.startsWith("~/") || /^\/|^[a-z]:\//i.test(text)) return null;
  text = text.replace(/^(\.\/)+/, "");
  if (!text || text.split("/").some((s) => s === ".." || s === "")) return null;
  // Needs a real extension: bare words and version numbers are not files.
  const ext = extOf(text);
  if (!ext || ext.length > 6 || !/[a-z]/i.test(ext)) return null;
  if (previewKindOf(text) === "unsupported" && !/^[a-z0-9]{1,5}$/i.test(ext)) return null;
  return text;
}

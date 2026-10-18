import { ApiError, apiFetch, apiJson } from "@/lib/backend/client";

export type WorkspaceEntry = {
  name: string;
  path: string;
  type: "file" | "dir";
  size: number;
  modifiedAt: string | null;
  hidden: boolean;
};

export type WorkspaceTreeResponse = {
  path: string;
  entries: WorkspaceEntry[];
};

export type WorkspaceFile = {
  path: string;
  name: string;
  size: number;
  mimeType: string;
  modifiedAt: string | null;
  isBinary: boolean;
  tooLarge?: boolean;
  content: string | null;
};

export type AgentFile = {
  name: string;
  content: string;
  size: number;
  modifiedAt: string | null;
};

const q = (value: string) => encodeURIComponent(value);
const hiddenQs = (showHidden: boolean) => (showHidden ? "&showHidden=1" : "");

export function fetchTree(path: string, showHidden: boolean) {
  return apiJson<WorkspaceTreeResponse>(
    `/api/workspace/tree?path=${q(path)}${hiddenQs(showHidden)}`,
  );
}

export function fetchFile(path: string, showHidden: boolean) {
  return apiJson<WorkspaceFile>(
    `/api/workspace/file?path=${q(path)}${hiddenQs(showHidden)}`,
  );
}

export function fetchAgentFiles() {
  return apiJson<AgentFile[]>("/api/workspace/agent-files");
}

/** Raw bytes as a Blob. The auth header can't ride on <img src>, so images are
 * fetched with apiFetch and shown through a blob URL. */
export async function fetchRawBlob(
  path: string,
  opts: { download?: boolean; showHidden?: boolean } = {},
): Promise<Blob> {
  const res = await apiFetch(
    `/api/workspace/file/raw?path=${q(path)}${opts.download ? "&download=1" : ""}${hiddenQs(!!opts.showHidden)}`,
  );
  if (!res.ok) throw new ApiError(`Download failed (${res.status})`, res.status, null);
  return res.blob();
}

function post<T>(url: string, body: unknown) {
  return apiJson<T>(url, { method: "POST", body: JSON.stringify(body) });
}

export const writeFile = (path: string, content: string) =>
  post<{ path: string; size: number; modifiedAt: string | null }>(
    "/api/workspace/write",
    { path, content },
  );
export const makeDir = (path: string) =>
  post<{ path: string }>("/api/workspace/mkdir", { path });
export const renamePath = (from: string, to: string) =>
  post<{ from: string; to: string }>("/api/workspace/rename", { from, to });
export const deletePath = (path: string) =>
  post<{ path: string }>("/api/workspace/delete", { path });

export function saveBlob(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

// ---------------------------------------------------------------------------
// Path + display helpers
// ---------------------------------------------------------------------------

export function parentPath(path: string): string {
  const i = path.lastIndexOf("/");
  return i < 0 ? "" : path.slice(0, i);
}

export function joinPath(dir: string, name: string): string {
  return dir ? `${dir}/${name}` : name;
}

export function baseName(path: string): string {
  return path.slice(path.lastIndexOf("/") + 1);
}

export function ancestorsOf(path: string): string[] {
  const parts = path.split("/").filter(Boolean);
  const out: string[] = [];
  for (let i = 1; i < parts.length; i++) out.push(parts.slice(0, i).join("/"));
  return out;
}

export function hasHiddenSegment(path: string): boolean {
  return path.split("/").some((s) => s.startsWith("."));
}

export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB"];
  const i = Math.min(units.length - 1, Math.floor(Math.log(bytes) / Math.log(1024)));
  const v = bytes / 1024 ** i;
  return `${i === 0 || v >= 10 ? Math.round(v) : v.toFixed(1)} ${units[i]}`;
}

export function formatModified(iso: string | null): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

export type FileKind = "markdown" | "json" | "code" | "text" | "image" | "other";

const CODE_EXTS = new Set([
  "ts", "tsx", "js", "jsx", "mjs", "cjs", "py", "rs", "go", "java", "c", "h",
  "cpp", "cs", "rb", "php", "sh", "bash", "zsh", "css", "scss", "html", "xml",
  "yml", "yaml", "toml", "sql", "swift", "kt", "lua", "ini", "svg",
]);
const IMAGE_EXTS = new Set(["png", "jpg", "jpeg", "gif", "webp", "avif", "bmp", "ico"]);
const TEXT_EXTS = new Set(["txt", "log", "csv", "tsv", "env", "conf", "cfg"]);

export function fileExt(name: string): string {
  const i = name.lastIndexOf(".");
  return i <= 0 ? "" : name.slice(i + 1).toLowerCase();
}

export function fileKind(name: string): FileKind {
  const ext = fileExt(name);
  if (ext === "md" || ext === "markdown" || ext === "mdx") return "markdown";
  if (ext === "json" || ext === "jsonl") return "json";
  if (IMAGE_EXTS.has(ext)) return "image";
  if (CODE_EXTS.has(ext)) return "code";
  if (TEXT_EXTS.has(ext)) return "text";
  return "other";
}

/** Returns an error message, or null when `name` is acceptable. */
export function validateName(name: string, allowNested: boolean): string | null {
  const n = name.trim();
  if (!n) return "Enter a name.";
  if (n.includes("\\") || n.includes("\0")) return "That name has invalid characters.";
  if (!allowNested && n.includes("/")) return "Names can't contain a slash.";
  const segs = n.split("/");
  if (n.startsWith("/") || segs.some((s) => s === "" || s === "." || s === ".."))
    return "That name isn't a valid path.";
  if (segs.some((s) => s.startsWith("."))) return "Names can't start with a dot.";
  return null;
}

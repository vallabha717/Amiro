"use client";

import Link from "next/link";
import * as React from "react";
import { motion, AnimatePresence } from "framer-motion";
import useSWR from "swr";
import { toast } from "sonner";
import {
  AlertCircle,
  ArrowLeft,
  ArrowUpDown,
  ChevronRight,
  Clock3,
  Code2,
  Copy,
  Check,
  Eye,
  FileCode,
  FileJson,
  FileText,
  Folder,
  FolderOpen,
  HardDrive,
  Home,
  Lock,
  Pencil,
  Save,
  Search,
  Settings2,
  ShieldAlert,
  Sparkles,
  X,
  PanelLeftClose,
  PanelLeftOpen,
} from "lucide-react";
import { Button } from "ui/button";
import { Input } from "ui/input";
import { Badge } from "ui/badge";
import { Separator } from "ui/separator";
import { Textarea } from "ui/textarea";
import { Skeleton } from "ui/skeleton";
import { cn, fetcher } from "lib/utils";
import { apiFetch } from "@/lib/backend/client";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface WorkspaceRootInfo {
  id: string;
  label: string;
  description: string;
  allowlisted?: boolean;
}

interface WorkspaceEntry {
  name: string;
  path: string;
  kind: "file" | "dir";
  size: number;
  updatedAt: string;
  ext: string;
}

interface WorkspaceListingResponse {
  roots: WorkspaceRootInfo[];
  activeRoot: string;
  currentPath: string;
  entries: WorkspaceEntry[];
  readOnly?: boolean;
}

interface WorkspaceFileResponse {
  root: string;
  path: string;
  name: string;
  size: number;
  updatedAt: string;
  ext: string;
  language: string;
  writable: boolean;
  truncated: boolean;
  content: string;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function formatBytes(n: number): string {
  if (n === 0) return "0 B";
  if (n < 1024) return `${n} B`;
  const units = ["KB", "MB", "GB"];
  let v = n / 1024;
  let idx = 0;
  while (v >= 1024 && idx < units.length - 1) {
    v /= 1024;
    idx++;
  }
  return `${v.toFixed(v < 10 ? 1 : 0)} ${units[idx]}`;
}

function formatRelativeTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const diff = Date.now() - d.getTime();
  const mins = Math.round(diff / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.round(hours / 24);
  if (days < 30) return `${days}d ago`;
  return d.toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

function formatTimestamp(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function iconForEntry(entry: WorkspaceEntry) {
  if (entry.kind === "dir") return Folder;
  const ext = entry.ext.toLowerCase();
  if (ext === ".json") return FileJson;
  if (ext === ".md" || ext === ".mdx") return FileText;
  if (ext === ".toml" || ext === ".yaml" || ext === ".yml") return Settings2;
  if (
    [
      ".ts",
      ".tsx",
      ".js",
      ".mjs",
      ".jsx",
      ".py",
      ".go",
      ".rs",
      ".css",
      ".html",
    ].includes(ext)
  )
    return FileCode;
  return Code2;
}

function isMarkdownLike(path: string, language: string): boolean {
  const lower = path.toLowerCase();
  return (
    lower.endsWith(".md") ||
    lower.endsWith(".mdx") ||
    language.toLowerCase() === "markdown"
  );
}

function isJsonLike(path: string, language: string): boolean {
  const lower = path.toLowerCase();
  return lower.endsWith(".json") || language.toLowerCase() === "json";
}

{}

// Workspace is files only. Memory has its own view at /agent/memory and is
// never rendered inside the workspace browser.
const QUICK_JUMP_FILES: Array<{ path: string; label: string }> = [
  { path: "IDENTITY.md", label: "IDENTITY.md" },
  { path: "SOUL.md", label: "SOUL.md" },
  { path: "prompt-overlay.md", label: "prompt-overlay.md" },
  { path: "config.toml", label: "config.toml" },
];

// ---------------------------------------------------------------------------
// Markdown formatted renderer (lightweight, no extra deps)
// ---------------------------------------------------------------------------

function InlineMarkdown({ text }: { text: string }) {
  const parts: React.ReactNode[] = [];
  const codeSplit = text.split(/(`[^`]+`)/g);
  codeSplit.forEach((segment, i) => {
    if (
      segment.startsWith("`") &&
      segment.endsWith("`") &&
      segment.length >= 2
    ) {
      parts.push(
        <code
          key={`c-${i}`}
          className="rounded bg-muted px-1 py-0.5 font-mono text-[0.85em] text-foreground"
        >
          {segment.slice(1, -1)}
        </code>,
      );
      return;
    }
    const linkParts = segment.split(/(\[[^\]]+\]\([^)]+\))/g);
    linkParts.forEach((lp, j) => {
      const m = lp.match(/^\[([^\]]+)\]\(([^)]+)\)$/);
      if (m) {
        parts.push(
          <a
            key={`l-${i}-${j}`}
            href={m[2]}
            target="_blank"
            rel="noreferrer"
            className="text-primary underline decoration-primary/30 underline-offset-2 hover:decoration-primary"
          >
            {m[1]}
          </a>,
        );
        return;
      }
      const boldSplit = lp.split(/(\*\*[^*]+\*\*)/g);
      boldSplit.forEach((bp, k) => {
        if (bp.startsWith("**") && bp.endsWith("**") && bp.length >= 4) {
          parts.push(
            <strong key={`b-${i}-${j}-${k}`} className="font-semibold">
              {bp.slice(2, -2)}
            </strong>,
          );
        } else if (
          bp.startsWith("*") &&
          bp.endsWith("*") &&
          bp.length >= 2 &&
          !bp.startsWith("**")
        ) {
          parts.push(
            <em key={`em-${i}-${j}-${k}`} className="italic">
              {bp.slice(1, -1)}
            </em>,
          );
        } else {
          parts.push(bp);
        }
      });
    });
  });
  return <>{parts}</>;
}

function MarkdownFormattedView({ content }: { content: string }) {
  const blocks = React.useMemo(() => {
    const lines = content.split("\n");
    const out: React.ReactNode[] = [];
    let idx = 0;
    let inCodeBlock = false;
    let codeLang = "";
    let codeLines: string[] = [];

    const flushCode = () => {
      if (codeLines.length === 0 && !inCodeBlock) return;
      const code = codeLines.join("\n");
      out.push(
        <pre
          key={`code-${idx++}`}
          className="my-4 overflow-x-auto rounded-lg border bg-muted/50 p-4 font-mono text-xs leading-relaxed"
        >
          {codeLang ? (
            <div className="mb-2 font-sans text-[10px] font-semibold uppercase tracking-widest text-muted-foreground">
              {codeLang}
            </div>
          ) : null}
          <code className="whitespace-pre">{code}</code>
        </pre>,
      );
      codeLines = [];
    };

    let pendingList: { ordered: boolean; items: string[] } | null = null;
    const flushList = () => {
      if (!pendingList) return;
      const { ordered, items } = pendingList;
      out.push(
        ordered ? (
          <ol
            key={`ol-${idx++}`}
            className="my-3 list-decimal space-y-1 pl-6 text-sm leading-relaxed"
          >
            {items.map((it, k) => (
              <li key={k}>
                <InlineMarkdown text={it} />
              </li>
            ))}
          </ol>
        ) : (
          <ul
            key={`ul-${idx++}`}
            className="my-3 list-disc space-y-1 pl-6 text-sm leading-relaxed"
          >
            {items.map((it, k) => (
              <li key={k}>
                <InlineMarkdown text={it} />
              </li>
            ))}
          </ul>
        ),
      );
      pendingList = null;
    };

    for (let lineIdx = 0; lineIdx < lines.length; lineIdx++) {
      const raw = lines[lineIdx];

      if (raw.trim().startsWith("```")) {
        if (!inCodeBlock) {
          flushList();
          inCodeBlock = true;
          codeLang = raw.trim().slice(3).trim();
          codeLines = [];
        } else {
          flushCode();
          inCodeBlock = false;
          codeLang = "";
        }
        continue;
      }
      if (inCodeBlock) {
        codeLines.push(raw);
        continue;
      }

      const trimmed = raw.trim();
      if (trimmed === "") {
        flushList();
        continue;
      }
      if (/^---+$/.test(trimmed) || /^\*\*\*+$/.test(trimmed)) {
        flushList();
        out.push(<Separator key={`hr-${idx++}`} className="my-6" />);
        continue;
      }
      const headingMatch = trimmed.match(/^(#{1,6})\s+(.*)$/);
      if (headingMatch) {
        flushList();
        const level = headingMatch[1].length;
        const text = headingMatch[2];
        if (level === 1) {
          out.push(
            <h1
              key={`h-${idx++}`}
              className="mt-8 text-2xl font-semibold tracking-tight"
            >
              <InlineMarkdown text={text} />
            </h1>,
          );
        } else if (level === 2) {
          out.push(
            <h2
              key={`h-${idx++}`}
              className="mt-6 text-lg font-semibold tracking-tight"
            >
              <InlineMarkdown text={text} />
            </h2>,
          );
        } else if (level === 3) {
          out.push(
            <h3
              key={`h-${idx++}`}
              className="mt-5 text-sm font-semibold uppercase tracking-widest text-muted-foreground"
            >
              <InlineMarkdown text={text} />
            </h3>,
          );
        } else {
          out.push(
            <h4 key={`h-${idx++}`} className="mt-4 text-sm font-semibold">
              <InlineMarkdown text={text} />
            </h4>,
          );
        }
        continue;
      }
      if (trimmed.startsWith("> ")) {
        flushList();
        out.push(
          <blockquote
            key={`bq-${idx++}`}
            className="my-3 border-l-2 border-muted-foreground/20 pl-4 text-sm italic text-muted-foreground"
          >
            <InlineMarkdown text={trimmed.slice(2)} />
          </blockquote>,
        );
        continue;
      }
      const ulMatch = raw.match(/^\s*[-*]\s+(.*)$/);
      const olMatch = raw.match(/^\s*\d+\.\s+(.*)$/);
      if (ulMatch) {
        if (pendingList && pendingList.ordered) flushList();
        if (!pendingList) pendingList = { ordered: false, items: [] };
        pendingList.items.push(ulMatch[1]);
        continue;
      }
      if (olMatch) {
        if (pendingList && !pendingList.ordered) flushList();
        if (!pendingList) pendingList = { ordered: true, items: [] };
        pendingList.items.push(olMatch[1]);
        continue;
      }

      flushList();
      const paraLines: string[] = [raw];
      while (lineIdx + 1 < lines.length) {
        const nxt = lines[lineIdx + 1];
        if (nxt.trim() === "") break;
        if (/^(#{1,6}\s|```|---|\*\*\*|> |- |\* |\d+\. )/.test(nxt.trim()))
          break;
        paraLines.push(nxt);
        lineIdx++;
      }
      const paraText = paraLines.join(" ").trim();
      if (paraText) {
        out.push(
          <p
            key={`p-${idx++}`}
            className="my-3 text-sm leading-7 text-foreground/90"
          >
            <InlineMarkdown text={paraText} />
          </p>,
        );
      }
    }
    if (inCodeBlock) flushCode();
    flushList();
    return out;
  }, [content]);

  if (!content.trim()) {
    return (
      <div className="rounded-xl border border-dashed bg-muted/30 px-6 py-12 text-center text-sm text-muted-foreground">
        Empty file
      </div>
    );
  }

  return (
    <article className="mx-auto max-w-3xl px-1 py-2">
      <div className="prose prose-neutral dark:prose-invert max-w-none prose-p:leading-7 prose-headings:tracking-tight">
        {blocks}
      </div>
    </article>
  );
}

// ---------------------------------------------------------------------------
// JSON parsing
// ---------------------------------------------------------------------------

function tryParseJson(content: string): unknown | null {
  try {
    return JSON.parse(content);
  } catch {
    return null;
  }
}

function BufferByteLength(s: string): number {
  try {
    return new TextEncoder().encode(s).length;
  } catch {
    return s.length;
  }
}

// ---------------------------------------------------------------------------
// Main component
// ---------------------------------------------------------------------------

export function AgentWorkspaceView() {
  const [activeRoot, setActiveRoot] = React.useState<string | null>(null);
  const [currentPath, setCurrentPath] = React.useState<string>("");
  const [selectedPath, setSelectedPath] = React.useState<string | null>(null);
  const [search, setSearch] = React.useState("");
  const [sortMode, setSortMode] = React.useState<"name" | "size">("name");
  const [viewMode, setViewMode] = React.useState<"formatted" | "source">(
    "formatted",
  );
  const [isEditing, setIsEditing] = React.useState(false);
  const [editContent, setEditContent] = React.useState("");
  const [saving, setSaving] = React.useState(false);
  const [saveError, setSaveError] = React.useState<string | null>(null);
  const [copied, setCopied] = React.useState(false);
  const [sidebarOpen, setSidebarOpen] = React.useState(true);

  const listingKey =
    activeRoot !== null
      ? `/api/agent/workspace?root=${encodeURIComponent(activeRoot)}&path=${encodeURIComponent(currentPath)}`
      : `/api/agent/workspace?path=${encodeURIComponent(currentPath)}`;

  const {
    data: listing,
    error: listingError,
    isLoading: listingLoading,
    mutate: mutateListing,
  } = useSWR<WorkspaceListingResponse>(listingKey, fetcher, {
    revalidateOnFocus: false,
    keepPreviousData: true,
  });

  // Sync activeRoot from server on first load
  React.useEffect(() => {
    if (listing && activeRoot === null) {
      setActiveRoot(listing.activeRoot);
      if (listing.currentPath !== undefined)
        setCurrentPath(listing.currentPath ?? "");
    }
  }, [listing, activeRoot]);

  const fileKey =
    activeRoot && selectedPath
      ? `/api/agent/workspace/file?root=${encodeURIComponent(activeRoot)}&path=${encodeURIComponent(selectedPath)}`
      : null;

  const {
    data: file,
    error: fileError,
    isLoading: fileLoading,
    mutate: mutateFile,
  } = useSWR<WorkspaceFileResponse>(fileKey, fetcher, {
    revalidateOnFocus: false,
  });

  // Keep edit buffer in sync when file changes and not currently editing
  React.useEffect(() => {
    if (file && !isEditing) {
      setEditContent(file.content);
      setSaveError(null);
    }
  }, [file, isEditing]);

  // Reset editing when file path changes
  React.useEffect(() => {
    setIsEditing(false);
    setSaveError(null);
  }, [selectedPath]);

  // Reset view mode default based on file type
  React.useEffect(() => {
    if (!file) return;
    if (
      isMarkdownLike(file.path, file.language) ||
      isJsonLike(file.path, file.language)
    ) {
      // keep previous choice or default to formatted
    } else {
      setViewMode("source");
    }
  }, [file?.path, file?.language]);

  const roots = listing?.roots ?? [];
  const entries = listing?.entries ?? [];

  // Filter + sort entries
  const filteredEntries = React.useMemo(() => {
    let out = [...entries];
    if (search.trim()) {
      const q = search.toLowerCase();
      out = out.filter(
        (e) =>
          e.name.toLowerCase().includes(q) || e.path.toLowerCase().includes(q),
      );
    }
    out.sort((a, b) => {
      if (a.kind !== b.kind) return a.kind === "dir" ? -1 : 1;
      if (sortMode === "size") return b.size - a.size;
      return a.name.localeCompare(b.name, undefined, { sensitivity: "base" });
    });
    return out;
  }, [entries, search, sortMode]);

  const breadcrumbSegments = React.useMemo(() => {
    if (!currentPath) return [];
    return currentPath.split("/").filter(Boolean);
  }, [currentPath]);

  const handleSelectRoot = (id: string) => {
    setActiveRoot(id);
    setCurrentPath("");
    setSelectedPath(null);
    setSearch("");
  };

  const handleNavigateBreadcrumb = (idx: number) => {
    if (idx < 0) setCurrentPath("");
    else setCurrentPath(breadcrumbSegments.slice(0, idx + 1).join("/"));
  };

  const handleEntryClick = (entry: WorkspaceEntry) => {
    if (entry.kind === "dir") {
      setCurrentPath(entry.path);
    } else {
      setSelectedPath(entry.path);
      if (window.innerWidth < 1024) setSidebarOpen(false);
    }
  };

  const handleQuickJump = (path: string) => {
    setSelectedPath(path);
    if (window.innerWidth < 1024) setSidebarOpen(false);
  };

  const handleCopy = async () => {
    if (!file?.content) return;
    try {
      await navigator.clipboard.writeText(file.content);
      setCopied(true);
      toast.success("Copied to clipboard");
      setTimeout(() => setCopied(false), 1400);
    } catch {
      toast.error("Copy failed");
    }
  };

  const handleSave = async () => {
    if (!file || !activeRoot || !selectedPath) return;
    setSaving(true);
    setSaveError(null);
    try {
      const res = await apiFetch("/api/agent/workspace/file", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          root: activeRoot,
          path: selectedPath,
          content: editContent,
        }),
      });
      if (!res.ok) {
        const payload = await res
          .json()
          .catch(() => ({ message: "Save failed" }));
        const msg =
          payload.error ||
          payload.message ||
          (res.status === 403
            ? "Admin privileges required or file is read-only"
            : "Save failed");
        throw new Error(msg);
      }
      const data = (await res.json().catch(() => ({}))) as {
        updatedAt?: string;
      };
      toast.success("File saved");
      setIsEditing(false);
      mutateFile(
        (prev) =>
          prev
            ? {
                ...prev,
                content: editContent,
                updatedAt: data.updatedAt ?? new Date().toISOString(),
                size: BufferByteLength(editContent),
              }
            : prev,
        false,
      );
      mutateListing();
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : "Save failed";
      setSaveError(msg);
      toast.error(msg);
    } finally {
      setSaving(false);
    }
  };

  const fileIsMarkdown = file
    ? isMarkdownLike(file.path, file.language)
    : false;
  const fileIsJson = file ? isJsonLike(file.path, file.language) : false;
  const showFormattedToggle = fileIsMarkdown || fileIsJson;
  const jsonParsed = fileIsJson && file ? tryParseJson(file.content) : null;

  const isListingForbidden =
    listingError &&
    ((listingError as { status?: number })?.status === 403 ||
      /forbidden|admin/i.test(
        listingError instanceof Error
          ? listingError.message
          : String(listingError),
      ));

  const isListingUnauthorized =
    listingError &&
    ((listingError as { status?: number })?.status === 401 ||
      /unauthorized|auth/i.test(
        listingError instanceof Error
          ? listingError.message
          : String(listingError),
      ));

  const isFileForbidden =
    fileError &&
    ((fileError as { status?: number })?.status === 403 ||
      /forbidden|admin|sensitive|allowlist|security/i.test(
        fileError instanceof Error ? fileError.message : String(fileError),
      ));

  return (
    <div
      style={{
        fontFamily:
          "var(--font-geist-sans), ui-sans-serif, system-ui, sans-serif",
      }}
      className="flex min-h-0 flex-1 flex-col gap-4 bg-background p-4 sm:p-6"
    >
      {/* Compact Header Card — title + one-line Amiro description + segmented root tabs + quick-jump pills */}
      <div className="rounded-xl border bg-card px-4 py-4 shadow-sm sm:px-5 sm:py-5">
        <div className="mx-auto w-full max-w-[1600px]">
          <Link
            href="/agent"
            className="inline-flex items-center gap-1.5 text-sm text-muted-foreground transition-colors hover:text-foreground"
          >
            <ArrowLeft className="size-3.5" />
            Back to Agent
          </Link>

          <div className="mt-3 flex flex-col gap-4">
            <div>
              <h1
                className="font-brand text-[22px] font-semibold tracking-[-0.02em] sm:text-[24px]"
                style={{ fontFamily: "var(--font-fraunces)" }}
              >
                Agent Workspace
              </h1>
              <p className="mt-1 max-w-3xl truncate text-sm leading-5 text-muted-foreground">
                Browse your agent files. Memory lives in its own view.
              </p>
            </div>

            {/* Root switcher */}
            <div className="flex flex-wrap items-center gap-3">
              <div
                data-testid="workspace-root-tabs"
                className="inline-flex rounded-xl border bg-muted/40 p-1"
                role="tablist"
                aria-label="Workspace roots"
              >
                {roots.length === 0 && !listingLoading ? (
                  <span className="px-3 py-1.5 text-xs text-muted-foreground">
                    {isListingForbidden
                      ? "Admin required"
                      : "Nothing to show here"}
                  </span>
                ) : listingLoading && roots.length === 0 ? (
                  <>
                    <Skeleton className="h-7 w-20 rounded-lg" />
                    <Skeleton className="h-7 w-20 rounded-lg" />
                    <Skeleton className="h-7 w-24 rounded-lg" />
                  </>
                ) : (
                  roots.map((root) => {
                    const active = root.id === activeRoot;
                    return (
                      <button
                        key={root.id}
                        type="button"
                        role="tab"
                        aria-selected={active}
                        aria-label={`Select workspace root: ${root.label}`}
                        onClick={() => handleSelectRoot(root.id)}
                        className={cn(
                          "rounded-lg px-3.5 py-1.5 text-sm font-medium transition-all outline-none focus-visible:ring-2 focus-visible:ring-ring",
                          active
                            ? "bg-background text-foreground shadow-sm ring-1 ring-border"
                            : "text-muted-foreground hover:text-foreground",
                        )}
                      >
                        {root.label}
                      </button>
                    );
                  })
                )}
              </div>
            </div>

            {/* Quick jump pills */}
            <div className="flex flex-wrap items-center gap-2">
              <span className="inline-flex items-center gap-1 text-xs font-medium text-muted-foreground">
                <Sparkles className="size-3.5" />
                Quick jump
              </span>
              {QUICK_JUMP_FILES.map((f) => (
                <button
                  key={f.path}
                  type="button"
                  aria-label={`Jump to file ${f.label}`}
                  onClick={() => handleQuickJump(f.path)}
                  className="inline-flex items-center gap-1.5 rounded-full border bg-card px-3 py-1 text-xs font-medium shadow-sm transition-colors hover:bg-accent hover:text-accent-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring"
                >
                  <span className="size-1.5 rounded-full bg-primary/60" />
                  {f.label}
                </button>
              ))}
            </div>
          </div>
        </div>
      </div>

      {/* Main two-pane grid — 320px tree card + viewer card, rounded-xl bordered cards */}
      <div className="grid min-h-0 flex-1 gap-4 lg:grid-cols-[320px_1fr]">
        {/* Mobile toolbar */}
        <div className="flex items-center gap-2 rounded-xl border bg-card px-3 py-2 shadow-sm lg:hidden">
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => setSidebarOpen((v) => !v)}
            aria-label={
              sidebarOpen ? "Hide workspace files" : "Show workspace files"
            }
          >
            {sidebarOpen ? (
              <PanelLeftClose className="size-4" />
            ) : (
              <PanelLeftOpen className="size-4" />
            )}
            {sidebarOpen ? "Hide files" : "Show files"}
          </Button>
          {selectedPath ? (
            <span className="truncate font-mono text-xs text-muted-foreground">
              {selectedPath}
            </span>
          ) : null}
        </div>

        {/* Left pane */}
        <AnimatePresence initial={false}>
          {(sidebarOpen || true) && (
            <motion.aside
              key="left-pane"
              initial={false}
              animate={{ opacity: 1, x: 0 }}
              className={cn(
                "flex min-h-0 min-w-0 flex-col overflow-hidden rounded-xl border bg-card shadow-sm lg:w-[320px]",
                !sidebarOpen && "hidden lg:flex",
              )}
            >
              {/* Search + sort */}
              <div className="space-y-3 border-b p-3">
                <div className="relative">
                  <Search className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground" />
                  <Input
                    data-testid="workspace-search-input"
                    value={search}
                    onChange={(e) => setSearch(e.target.value)}
                    placeholder="Filter files"
                    aria-label="Filter files and folders"
                    className="h-8 bg-background pl-8 text-sm"
                  />
                  {search ? (
                    <button
                      type="button"
                      onClick={() => setSearch("")}
                      className="absolute top-1/2 right-1.5 -translate-y-1/2 rounded p-1 hover:bg-accent"
                      aria-label="Clear search"
                    >
                      <X className="size-3.5" />
                    </button>
                  ) : null}
                </div>

                <div className="flex items-center justify-between gap-2">
                  <div className="inline-flex rounded-lg border bg-muted/30 p-0.5">
                    <button
                      type="button"
                      aria-pressed={sortMode === "name"}
                      onClick={() => setSortMode("name")}
                      className={cn(
                        "rounded-md px-2.5 py-1 text-xs font-medium transition-colors outline-none focus-visible:ring-2 focus-visible:ring-ring",
                        sortMode === "name"
                          ? "bg-background shadow-sm ring-1 ring-border"
                          : "text-muted-foreground hover:text-foreground",
                      )}
                    >
                      Name
                    </button>
                    <button
                      type="button"
                      aria-pressed={sortMode === "size"}
                      onClick={() => setSortMode("size")}
                      className={cn(
                        "rounded-md px-2.5 py-1 text-xs font-medium transition-colors outline-none focus-visible:ring-2 focus-visible:ring-ring",
                        sortMode === "size"
                          ? "bg-background shadow-sm ring-1 ring-border"
                          : "text-muted-foreground hover:text-foreground",
                      )}
                    >
                      Size
                    </button>
                  </div>
                  <span className="inline-flex items-center gap-1 text-xs tabular-nums text-muted-foreground">
                    <ArrowUpDown className="size-3" />
                    {filteredEntries.length} items
                  </span>
                </div>
              </div>

              {/* Breadcrumbs */}
              <nav
                aria-label="Workspace breadcrumbs"
                className="flex items-center gap-1 border-b bg-muted/20 px-3 py-2 text-xs"
              >
                <button
                  type="button"
                  onClick={() => handleNavigateBreadcrumb(-1)}
                  className="inline-flex items-center gap-1 rounded px-1.5 py-1 hover:bg-accent outline-none focus-visible:ring-2 focus-visible:ring-ring"
                  title="Go to root"
                  aria-label="Go to root directory"
                >
                  <Home className="size-3.5" />
                  <span className="hidden sm:inline">Root</span>
                </button>
                {breadcrumbSegments.map((seg, i) => (
                  <React.Fragment key={`${seg}-${i}`}>
                    <ChevronRight className="size-3 text-muted-foreground" />
                    <button
                      type="button"
                      onClick={() => handleNavigateBreadcrumb(i)}
                      className={cn(
                        "max-w-[120px] truncate rounded px-1.5 py-1 hover:bg-accent outline-none focus-visible:ring-2 focus-visible:ring-ring",
                        i === breadcrumbSegments.length - 1 &&
                          "font-semibold text-foreground",
                      )}
                      title={seg}
                      aria-label={`Go to ${seg}`}
                    >
                      {seg}
                    </button>
                  </React.Fragment>
                ))}
                <div className="ml-auto hidden items-center gap-1 text-[11px] text-muted-foreground sm:flex">
                  <Clock3 className="size-3" />
                  <span className="truncate font-mono tabular-nums">
                    {currentPath || "/"}
                  </span>
                </div>
              </nav>

              {/* Entry list */}
              <div className="min-h-0 flex-1 overflow-auto">
                {isListingForbidden ? (
                  <div
                    role="alert"
                    aria-live="polite"
                    className="flex flex-col items-center justify-center p-8 text-center"
                  >
                    <div className="flex size-11 items-center justify-center rounded-2xl border border-destructive/20 bg-destructive/10 text-destructive">
                      <ShieldAlert className="size-5" />
                    </div>
                    <div className="mt-3 text-sm font-semibold">
                      Administrator Required
                    </div>
                    <div className="mt-1 text-xs leading-relaxed text-muted-foreground">
                      Workspace inspection is gated to administrators. Non-admin
                      users cannot browse machine files.
                    </div>
                  </div>
                ) : isListingUnauthorized ? (
                  <div
                    role="alert"
                    aria-live="polite"
                    className="flex flex-col items-center justify-center p-8 text-center"
                  >
                    <div className="flex size-11 items-center justify-center rounded-2xl border border-border/70 bg-card">
                      <Lock className="size-5 text-muted-foreground" />
                    </div>
                    <div className="mt-3 text-sm font-semibold">
                      Authentication Required
                    </div>
                    <div className="mt-1 text-xs text-muted-foreground">
                      Please sign in to access the agent workspace.
                    </div>
                  </div>
                ) : listingError ? (
                  <div role="alert" className="p-6 text-sm text-destructive">
                    Failed to load workspace:{" "}
                    {(listingError as Error).message ?? "Unknown error"}
                  </div>
                ) : listingLoading ? (
                  <div className="space-y-2 p-3">
                    {Array.from({ length: 10 }).map((_, i) => (
                      <div
                        key={i}
                        className="flex items-center gap-3 rounded-lg border bg-background px-3 py-2.5"
                      >
                        <Skeleton className="size-8 rounded-lg" />
                        <div className="flex-1 space-y-1.5">
                          <Skeleton className="h-3 w-2/3" />
                          <Skeleton className="h-2.5 w-1/2" />
                        </div>
                      </div>
                    ))}
                  </div>
                ) : filteredEntries.length === 0 ? (
                  <div className="flex flex-col items-center justify-center px-6 py-16 text-center">
                    <div className="flex size-10 items-center justify-center rounded-xl border bg-muted/50">
                      <FolderOpen className="size-5 text-muted-foreground" />
                    </div>
                    <div className="mt-3 text-sm font-medium">
                      {search ? "No matching files" : "Empty folder"}
                    </div>
                    <div className="mt-1 max-w-[22ch] text-xs leading-relaxed text-muted-foreground">
                      {search
                        ? "No files match your search."
                        : "This folder is empty."}
                    </div>
                    {currentPath ? (
                      <Button
                        variant="outline"
                        size="sm"
                        type="button"
                        className="mt-4"
                        onClick={() => setCurrentPath("")}
                      >
                        Back to root
                      </Button>
                    ) : null}
                  </div>
                ) : (
                  <ul
                    className="space-y-1 p-2"
                    role="list"
                    aria-label="Workspace entries"
                  >
                    {filteredEntries.map((entry) => {
                      const Icon = iconForEntry(entry);
                      const selected = selectedPath === entry.path;
                      const isDir = entry.kind === "dir";
                      return (
                        <li key={entry.path}>
                          <button
                            type="button"
                            data-testid="workspace-entry"
                            aria-label={`Open ${isDir ? "folder" : "file"} ${entry.name}`}
                            onClick={() => handleEntryClick(entry)}
                            className={cn(
                              "group flex w-full items-center gap-3 rounded-lg border px-3 py-2.5 text-left transition-colors outline-none focus-visible:ring-2 focus-visible:ring-ring",
                              selected
                                ? "border-primary/20 bg-primary/[0.06] ring-1 ring-primary/10"
                                : "border-transparent bg-background hover:border-border hover:bg-accent/50",
                            )}
                          >
                            <span
                              className={cn(
                                "flex size-8 shrink-0 items-center justify-center rounded-lg border",
                                isDir
                                  ? "border-amber-200/50 bg-amber-500/10 text-amber-600 dark:text-amber-400"
                                  : "bg-muted text-muted-foreground",
                                selected &&
                                  !isDir &&
                                  "border-primary/20 bg-primary/10 text-primary",
                              )}
                            >
                              <Icon className="size-4" />
                            </span>
                            <span className="min-w-0 flex-1">
                              <span className="block truncate text-sm font-medium leading-none">
                                {entry.name}
                              </span>
                              <span className="mt-1 flex items-center gap-2 text-xs text-muted-foreground">
                                {isDir ? (
                                  <span className="inline-flex items-center gap-1">
                                    <Folder className="size-3" /> folder
                                  </span>
                                ) : (
                                  <>
                                    <span className="font-mono tabular-nums">
                                      {formatBytes(entry.size)}
                                    </span>
                                    <span className="size-1 rounded-full bg-muted-foreground/30" />
                                    <span className="tabular-nums">
                                      {formatRelativeTime(entry.updatedAt)}
                                    </span>
                                  </>
                                )}
                              </span>
                            </span>
                            <ChevronRight
                              className={cn(
                                "size-4 shrink-0 text-muted-foreground/50 transition-transform",
                                isDir && "group-hover:translate-x-0.5",
                              )}
                            />
                          </button>
                        </li>
                      );
                    })}
                  </ul>
                )}
              </div>

              <div className="border-t bg-muted/20 px-4 py-3 text-xs leading-relaxed text-muted-foreground">
                Read-only preview. Change your agent’s persona in Personality.
              </div>
            </motion.aside>
          )}
        </AnimatePresence>

        {/* Right pane — viewer card */}
        <section className="flex min-h-[420px] min-w-0 flex-col overflow-hidden rounded-xl border bg-card shadow-sm">
          {isListingForbidden ? (
            <div
              role="alert"
              className="flex flex-1 flex-col items-center justify-center px-6 py-16 text-center"
            >
              <div className="flex size-14 items-center justify-center rounded-2xl border border-destructive/20 bg-destructive/10 text-destructive">
                <ShieldAlert className="size-7" />
              </div>
              <h3 className="mt-4 text-base font-semibold">
                Workspace Gated to Administrators
              </h3>
              <p className="mt-1 max-w-md text-sm leading-relaxed text-muted-foreground">
                To protect system and machine files, the agent workspace browser
                requires administrator privileges. Sign in as an administrator
                to inspect and configure agent files.
              </p>
            </div>
          ) : !selectedPath ? (
            <div className="flex flex-1 flex-col items-center justify-center px-6 py-16 text-center">
              <div className="flex size-14 items-center justify-center rounded-2xl border bg-card shadow-sm">
                <Eye className="size-6 text-muted-foreground" />
              </div>
              <h3 className="mt-4 text-sm font-semibold">
                Select a file to preview
              </h3>
              <p className="mt-1 max-w-md text-sm leading-relaxed text-muted-foreground">
                Choose a file on the left to preview its contents.
              </p>
              <div className="mt-6 flex flex-wrap justify-center gap-2">
                {QUICK_JUMP_FILES.slice(0, 3).map((f) => (
                  <button
                    key={f.path}
                    type="button"
                    aria-label={`Quick jump to ${f.label}`}
                    onClick={() => handleQuickJump(f.path)}
                    className="rounded-full border bg-card px-3 py-1 text-xs font-medium hover:bg-accent outline-none focus-visible:ring-2 focus-visible:ring-ring"
                  >
                    {f.label}
                  </button>
                ))}
              </div>
            </div>
          ) : isFileForbidden ? (
            <div
              role="alert"
              className="flex flex-1 flex-col items-center justify-center px-6 py-16 text-center"
            >
              <div className="flex size-12 items-center justify-center rounded-xl bg-destructive/10 text-destructive">
                <ShieldAlert className="size-6" />
              </div>
              <div className="mt-3 text-sm font-semibold">
                Access Restricted
              </div>
              <div className="mt-1 max-w-md text-sm text-muted-foreground">
                {(fileError as Error).message ??
                  "This file is outside the safe workspace allowlist or requires administrator access."}
              </div>
              <Button
                variant="outline"
                size="sm"
                type="button"
                className="mt-4"
                onClick={() => setSelectedPath(null)}
              >
                Clear selection
              </Button>
            </div>
          ) : fileError ? (
            <div
              role="alert"
              className="flex flex-1 flex-col items-center justify-center px-6 py-16 text-center"
            >
              <div className="flex size-12 items-center justify-center rounded-xl bg-destructive/10 text-destructive">
                <X className="size-6" />
              </div>
              <div className="mt-3 text-sm font-semibold">
                Could not open file
              </div>
              <div className="mt-1 max-w-md text-sm text-muted-foreground">
                {(fileError as Error).message ??
                  "The file may not exist in this root or is not readable."}
              </div>
              <Button
                variant="outline"
                size="sm"
                type="button"
                className="mt-4"
                onClick={() => setSelectedPath(null)}
              >
                Clear selection
              </Button>
            </div>
          ) : fileLoading || !file ? (
            <div className="flex flex-1 flex-col">
              <div className="border-b px-6 py-4">
                <Skeleton className="h-5 w-48" />
                <Skeleton className="mt-2 h-4 w-72" />
              </div>
              <div className="flex-1 space-y-3 p-6">
                <Skeleton className="h-4 w-full" />
                <Skeleton className="h-4 w-[90%]" />
                <Skeleton className="h-32 w-full rounded-xl" />
              </div>
            </div>
          ) : (
            <>
              {/* File header */}
              <div className="shrink-0 border-b bg-card/50 px-4 py-4 sm:px-6">
                <div className="flex flex-col gap-3">
                  <div className="flex flex-wrap items-start justify-between gap-3">
                    <div className="min-w-0">
                      <div className="flex flex-wrap items-center gap-2">
                        <h2 className="truncate text-base font-semibold tracking-tight">
                          {file.name}
                        </h2>
                        <Badge
                          variant="secondary"
                          className="font-mono text-[11px] font-normal tabular-nums"
                        >
                          {file.ext || file.language || "file"}
                        </Badge>
                        {file.writable ? (
                          <Badge
                            variant="outline"
                            className="border-emerald-200 bg-emerald-50 text-emerald-700 dark:border-emerald-900 dark:bg-emerald-950/40 dark:text-emerald-300"
                          >
                            writable
                          </Badge>
                        ) : (
                          <Badge
                            variant="outline"
                            className="text-muted-foreground"
                          >
                            read only
                          </Badge>
                        )}
                        {file.truncated ? (
                          <Badge variant="destructive" className="text-[11px]">
                            truncated
                          </Badge>
                        ) : null}
                      </div>
                      <div className="mt-2 flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                        <span className="inline-flex items-center gap-1.5 rounded-full border bg-background px-2.5 py-1 font-mono tabular-nums">
                          {file.path}
                        </span>
                        <span className="inline-flex items-center gap-1 tabular-nums">
                          <HardDrive className="size-3" />
                          {formatBytes(file.size)}
                        </span>
                        <span className="size-1 rounded-full bg-muted-foreground/30" />
                        <span className="inline-flex items-center gap-1 tabular-nums">
                          <Clock3 className="size-3" />
                          {formatTimestamp(file.updatedAt)}
                        </span>
                      </div>
                    </div>

                    <div className="flex items-center gap-2">
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        onClick={handleCopy}
                        aria-label="Copy file content to clipboard"
                        className="gap-1.5"
                      >
                        {copied ? (
                          <Check className="size-4 text-emerald-600" />
                        ) : (
                          <Copy className="size-4" />
                        )}
                        {copied ? "Copied" : "Copy"}
                      </Button>

                      {file.writable ? (
                        isEditing ? (
                          <Button
                            type="button"
                            data-testid="workspace-save-button"
                            size="sm"
                            onClick={handleSave}
                            disabled={saving}
                            aria-label="Save file modifications"
                            className="gap-1.5"
                          >
                            <Save className="size-4" />
                            {saving ? "Saving" : "Save"}
                          </Button>
                        ) : (
                          <Button
                            type="button"
                            data-testid="workspace-edit-button"
                            size="sm"
                            variant="secondary"
                            onClick={() => {
                              setEditContent(file.content);
                              setSaveError(null);
                              setIsEditing(true);
                            }}
                            aria-label="Edit file in place"
                            className="gap-1.5"
                          >
                            <Pencil className="size-4" />
                            Edit
                          </Button>
                        )
                      ) : null}
                    </div>
                  </div>

                  {/* View mode toggle */}
                  {showFormattedToggle ? (
                    <div className="flex flex-wrap items-center gap-2">
                      <div
                        data-testid="workspace-view-mode"
                        className="inline-flex rounded-lg border bg-muted/40 p-0.5"
                        role="tablist"
                        aria-label="View mode"
                      >
                        <button
                          type="button"
                          role="tab"
                          aria-selected={viewMode === "formatted"}
                          aria-label="Formatted view"
                          onClick={() => setViewMode("formatted")}
                          className={cn(
                            "inline-flex items-center gap-1.5 rounded-md px-3 py-1.5 text-xs font-medium transition-colors outline-none focus-visible:ring-2 focus-visible:ring-ring",
                            viewMode === "formatted"
                              ? "bg-background text-foreground shadow-sm ring-1 ring-border"
                              : "text-muted-foreground hover:text-foreground",
                          )}
                        >
                          <Eye className="size-3.5" />
                          Formatted
                        </button>
                        <button
                          type="button"
                          role="tab"
                          aria-selected={viewMode === "source"}
                          aria-label="Source code view"
                          onClick={() => setViewMode("source")}
                          className={cn(
                            "inline-flex items-center gap-1.5 rounded-md px-3 py-1.5 text-xs font-medium transition-colors outline-none focus-visible:ring-2 focus-visible:ring-ring",
                            viewMode === "source"
                              ? "bg-background text-foreground shadow-sm ring-1 ring-border"
                              : "text-muted-foreground hover:text-foreground",
                          )}
                        >
                          <Code2 className="size-3.5" />
                          Source
                        </button>
                      </div>
                      {isEditing ? (
                        <span className="text-xs text-muted-foreground">
                          Editing source directly
                        </span>
                      ) : null}
                    </div>
                  ) : null}
                </div>
              </div>

              {/* File body */}
              <div className="min-h-0 flex-1 overflow-auto bg-background">
                {isEditing ? (
                  <div className="p-4 sm:p-6">
                    {saveError ? (
                      <div
                        role="alert"
                        aria-live="assertive"
                        className="mb-3 flex items-center gap-2 rounded-xl border border-destructive/30 bg-destructive/10 px-3 py-2 text-xs text-destructive"
                      >
                        <AlertCircle className="size-4 shrink-0" />
                        <span>{saveError}</span>
                      </div>
                    ) : null}
                    <Textarea
                      value={editContent}
                      onChange={(e) => {
                        setEditContent(e.target.value);
                        if (saveError) setSaveError(null);
                      }}
                      aria-label={`File content for ${file.name}`}
                      className="min-h-[420px] font-mono text-sm leading-relaxed"
                      placeholder="File content"
                      spellCheck={false}
                    />
                    <div className="mt-3 flex items-center justify-between gap-3">
                      <span className="text-xs tabular-nums text-muted-foreground">
                        {formatBytes(BufferByteLength(editContent))} ·{" "}
                        {editContent.split("\n").length} lines
                      </span>
                      <span className="text-xs text-muted-foreground">
                        Save to update the live file on disk
                      </span>
                    </div>
                  </div>
                ) : fileIsMarkdown && viewMode === "formatted" ? (
                  <div className="p-4 sm:p-6">
                    <MarkdownFormattedView content={file.content} />
                  </div>
                ) : fileIsJson &&
                  viewMode === "formatted" &&
                  jsonParsed !== null ? (
                  <div className="space-y-4 p-4 sm:p-6">
                    <div className="rounded-xl border bg-card p-4 shadow-sm">
                      <div className="mb-2 flex items-center justify-between">
                        <span className="text-xs font-semibold uppercase tracking-widest text-muted-foreground">
                          JSON
                        </span>
                        <span className="font-mono text-xs tabular-nums text-muted-foreground">
                          {Array.isArray(jsonParsed)
                            ? `${(jsonParsed as unknown[]).length} items`
                            : Object.keys(jsonParsed as object).length +
                              " keys"}
                        </span>
                      </div>
                      <pre className="overflow-x-auto whitespace-pre-wrap break-words rounded-lg bg-muted/40 p-4 font-mono text-xs leading-relaxed">
                        {JSON.stringify(jsonParsed, null, 2)}
                      </pre>
                    </div>
                  </div>
                ) : (
                  <div className="p-4 sm:p-6">
                    <div className="overflow-hidden rounded-xl border bg-muted/20">
                      <div className="flex items-center justify-between border-b bg-card px-3 py-2">
                        <span className="font-mono text-xs tabular-nums text-muted-foreground">
                          {file.language || file.ext || "text"} ·{" "}
                          {file.content.split("\n").length} lines
                        </span>
                        {file.truncated ? (
                          <span className="text-xs font-medium text-amber-600">
                            Preview truncated
                          </span>
                        ) : null}
                      </div>
                      <pre className="max-h-[70vh] overflow-auto p-4 font-mono text-xs leading-6">
                        <code className="whitespace-pre-wrap break-words">
                          {file.content || "(empty file)"}
                        </code>
                      </pre>
                    </div>
                  </div>
                )}
              </div>
            </>
          )}
        </section>
      </div>
    </div>
  );
}

"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { useTranslations } from "next-intl";
import { mutate as globalMutate } from "swr";
import { appStore } from "@/app/store";
import type { ChatFile } from "lib/file-preview/chat-files";
import { useOpenWorkspaceFile } from "@/components/file-preview/use-open-workspace-file";
import { WorkspaceFileViewer } from "@/components/workspace-browser/workspace-file-viewer";
import { toast } from "sonner";
import { Button } from "ui/button";
import { cn } from "lib/utils";
import {
  DownloadIcon,
  FilePlusIcon,
  FileTextIcon,
  RefreshCwIcon,
  Trash2Icon,
  XIcon,
} from "lucide-react";
import {
  createFileArtifact,
  deleteFileArtifact,
  downloadArtifactBlob,
  formatSize,
  artifactKindLabel,
  useFileArtifacts,
  type FileArtifact,
} from "@/lib/backend/artifacts-api";

/**
 * File artifacts: documents the user or the agent generated — markdown, html,
 * code, csv, pdf, word — saved as real files under
 * `workspace/artifacts/<user>/<id>/<file>` and previewed here.
 */
export function FileArtifactsPanel({
  threadId,
  chatFiles = [],
}: {
  threadId?: string;
  chatFiles?: ChatFile[];
}) {
  const t = useTranslations("Chat.Artifact");
  const { data, error, isLoading, mutate } = useFileArtifacts(true);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  // Deep selection: the chat card's Open button stores the artifact id here
  // so the pane lands with the right file already previewing.
  const requestedFileId = appStore((s) => s.artifactView.fileId);
  useEffect(() => {
    if (requestedFileId) setSelectedId(requestedFileId);
  }, [requestedFileId]);

  const items = useMemo(() => data ?? [], [data]);
  const openWorkspaceFile = useOpenWorkspaceFile();
  // A chat file that is also a saved artifact is listed once, as the artifact.
  const registered = useMemo(() => new Set(items.map((a) => a.workspacePath)), [items]);
  const chatOnly = useMemo(
    () => chatFiles.filter((f) => !registered.has(f.path)),
    [chatFiles, registered],
  );
  const selected = items.find((a) => a.id === selectedId) ?? null;

  // Note: no effect clears a selection the list does not (yet) contain.
  // The list is shared SWR state and can serve a stale empty page while it
  // revalidates; clearing on mismatch deleted deep selections (the chat
  // card's Open button) the moment they were made. Deleting from the panel
  // resets the selection explicitly through onDeleted instead.

  async function refresh() {
    await mutate();
    await globalMutate("/api/artifacts");
  }

  return (
    <div
      className="flex h-full min-h-0 flex-col"
      data-testid="artifacts-panel"
    >
      <div className="flex shrink-0 items-center gap-2 border-b px-3 py-2">
        <h2 className="text-xs font-semibold">{t("filesTitle")}</h2>
        <span className="text-[11px] text-muted-foreground">
          {t("filesCount", { count: items.length + chatOnly.length })}
        </span>
        <div className="ml-auto flex items-center gap-1">
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className="size-7"
            aria-label={t("refresh")}
            title={t("refresh")}
            data-testid="artifacts-refresh"
            onClick={() => void refresh()}
          >
            <RefreshCwIcon className="size-3.5" />
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className="size-7"
            aria-label={t("newArtifact")}
            title={t("newArtifact")}
            data-testid="artifacts-new"
            onClick={() => {
              setCreating((v) => !v);
              setSelectedId(null);
            }}
          >
            <FilePlusIcon className="size-3.5" />
          </Button>
        </div>
      </div>

      {creating && (
        <CreateForm
          threadId={threadId}
          onDone={(created) => {
            setCreating(false);
            void mutate();
            setSelectedId(created.id);
          }}
          onCancel={() => setCreating(false)}
        />
      )}

      <div className="flex min-h-0 flex-1 flex-col overflow-hidden md:flex-row">
        <ul className="max-h-40 shrink-0 divide-y overflow-y-auto border-b md:max-h-none md:w-56 md:border-b-0 md:border-r">
          {isLoading && (
            <li className="px-3 py-4 text-xs text-muted-foreground">
              {t("loading")}
            </li>
          )}
          {error && (
            <li className="px-3 py-4 text-xs text-destructive">
              {t("filesError")}
            </li>
          )}
          {!isLoading && !error && items.length === 0 && chatOnly.length === 0 && !creating && (
            <li className="px-3 py-4 text-xs text-muted-foreground">
              {t("noFilesYet")}
            </li>
          )}
          {chatOnly.length > 0 && (
            <li
              className="bg-muted/40 px-3 py-1.5 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground"
              data-testid="chat-files-heading"
            >
              {t("chatFilesTitle")}
            </li>
          )}
          {chatOnly.map((f) => (
            <li key={`chat:${f.path}`}>
              <button
                type="button"
                data-testid="chat-file-item"
                data-path={f.path}
                onClick={() => {
                  setCreating(false);
                  setSelectedId(null);
                  openWorkspaceFile(f.path);
                }}
                className="flex w-full items-center gap-2 px-3 py-2 text-left text-xs transition-colors hover:bg-muted/60"
              >
                <FileTextIcon className="size-3.5 shrink-0 text-muted-foreground" />
                <span className="min-w-0 flex-1">
                  <span className="block truncate font-medium">{f.name}</span>
                  <span className="block truncate text-[11px] text-muted-foreground">
                    {f.path}
                  </span>
                </span>
              </button>
            </li>
          ))}
          {items.map((a) => (
            <li key={a.id}>
              <button
                type="button"
                data-testid={`artifact-item-${a.id}`}
                onClick={() => {
                  setCreating(false);
                  setSelectedId(a.id);
                }}
                className={cn(
                  "flex w-full items-center gap-2 px-3 py-2 text-left text-xs transition-colors hover:bg-muted/60",
                  selectedId === a.id && "bg-accent text-accent-foreground",
                )}
              >
                <FileTextIcon className="size-3.5 shrink-0 text-muted-foreground" />
                <span className="min-w-0 flex-1">
                  <span className="block truncate font-medium">
                    {a.title}
                  </span>
                  <span className="block truncate text-[11px] text-muted-foreground">
                    {artifactKindLabel(a)} · {a.filename} ·{" "}
                    {formatSize(a.size)}
                  </span>
                </span>
              </button>
            </li>
          ))}
        </ul>

        <div className="min-h-0 min-w-0 flex-1 overflow-hidden">
          {selected ? (
            <ArtifactPreview
              key={selected.id}
              artifact={selected}
              onDeleted={() => {
                setSelectedId(null);
                void mutate();
              }}
            />
          ) : (
            !creating && (
              <div className="flex h-full items-center justify-center p-6">
                <p className="max-w-xs text-center text-xs text-muted-foreground">
                  {items.length === 0 ? t("noFilesYet") : t("selectFile")}
                </p>
              </div>
            )
          )}
        </div>
      </div>
    </div>
  );
}

function ArtifactPreview({
  artifact,
  onDeleted,
}: {
  artifact: FileArtifact;
  onDeleted: () => void;
}) {
  const t = useTranslations("Chat.Artifact");
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const [busy, setBusy] = useState(false);

  async function download() {
    setBusy(true);
    try {
      const blob = await downloadArtifactBlob(artifact.id);
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = artifact.filename;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 5000);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : t("filesError"));
    } finally {
      setBusy(false);
    }
  }

  async function remove() {
    setBusy(true);
    try {
      await deleteFileArtifact(artifact.id);
      toast.success(t("fileDeleted"));
      onDeleted();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : t("filesError"));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex shrink-0 items-center gap-2 border-b px-3 py-1.5">
        <span className="min-w-0 flex-1 truncate text-xs font-medium">
          {artifact.title}
        </span>
        <span className="shrink-0 rounded bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground">
          {artifactKindLabel(artifact)}
        </span>
        <Button
          type="button"
          variant="ghost"
          size="icon"
          className="size-7"
          aria-label={t("download")}
          title={t("download")}
          data-testid="artifact-download"
          disabled={busy}
          onClick={() => void download()}
        >
          <DownloadIcon className="size-3.5" />
        </Button>
        {confirmingDelete ? (
          <Button
            type="button"
            variant="destructive"
            size="sm"
            className="h-7 text-xs"
            data-testid="artifact-delete-confirm"
            disabled={busy}
            onClick={() => void remove()}
          >
            {t("confirmDelete")}
          </Button>
        ) : (
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className="size-7"
            aria-label={t("delete")}
            title={t("delete")}
            data-testid="artifact-delete"
            disabled={busy}
            onClick={() => setConfirmingDelete(true)}
          >
            <Trash2Icon className="size-3.5" />
          </Button>
        )}
      </div>
      {/* The same viewer the chat's file paths and the Workspace page use, so a
          file looks identical wherever it is opened from. */}
      <div
        className="flex min-h-0 flex-1 flex-col p-2 [&>section]:min-h-0 [&>section]:flex-1"
        data-testid="artifact-viewer"
      >
        <WorkspaceFileViewer
          key={artifact.workspacePath}
          source={{ kind: "workspace", path: artifact.workspacePath }}
          canWrite={false}
          showHidden={false}
          onSaved={noop}
          onDirtyChange={noop}
        />
      </div>
    </div>
  );
}

const noop = () => {};

function CreateForm({
  threadId,
  onDone,
  onCancel,
}: {
  threadId?: string;
  onDone: (created: FileArtifact) => void;
  onCancel: () => void;
}) {
  const t = useTranslations("Chat.Artifact");
  const [title, setTitle] = useState("");
  const [filename, setFilename] = useState("notes.md");
  const [content, setContent] = useState("");
  const [busy, setBusy] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!content.trim()) {
      toast.error(t("contentRequired"));
      return;
    }
    setBusy(true);
    try {
      const created = await createFileArtifact({
        title: title.trim() || undefined,
        filename: filename.trim() || "notes.md",
        contentText: content,
        threadId,
      });
      toast.success(t("fileCreated"));
      onDone(created);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : t("filesError"));
    } finally {
      setBusy(false);
    }
  }

  return (
    <form
      onSubmit={(e) => void submit(e)}
      data-testid="artifact-create-form"
      className="space-y-2 border-b p-3"
    >
      <div className="grid grid-cols-2 gap-2">
        <label className="block text-xs">
          <span className="mb-1 block text-muted-foreground">{t("title")}</span>
          <input
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder={t("titlePlaceholder")}
            data-testid="artifact-create-title"
            className="w-full rounded-md border bg-background px-2 py-1.5 text-xs"
          />
        </label>
        <label className="block text-xs">
          <span className="mb-1 block text-muted-foreground">{t("filename")}</span>
          <input
            value={filename}
            onChange={(e) => setFilename(e.target.value)}
            placeholder="notes.md"
            data-testid="artifact-create-filename"
            className="w-full rounded-md border bg-background px-2 py-1.5 font-mono text-xs"
          />
        </label>
      </div>
      <label className="block text-xs">
        <span className="mb-1 block text-muted-foreground">{t("content")}</span>
        <textarea
          value={content}
          onChange={(e) => setContent(e.target.value)}
          rows={5}
          data-testid="artifact-create-content"
          className="w-full rounded-md border bg-background px-2 py-1.5 font-mono text-xs"
        />
      </label>
      <div className="flex justify-end gap-2">
        <Button type="button" variant="ghost" size="sm" onClick={onCancel}>
          <XIcon className="size-3.5" />
          {t("cancel")}
        </Button>
        <Button type="submit" size="sm" disabled={busy} data-testid="artifact-create-submit">
          {t("create")}
        </Button>
      </div>
    </form>
  );
}

/**
 * Open the artifact pane on the Files tab with one file selected.
 *
 * Same "right now" contract as useOpenArtifact: the click and the mount
 * happen on the same commit, so the document is in front of the user with
 * no perceptible lag.
 */
export function useOpenArtifactFile() {
  const mutate = appStore((state) => state.mutate);
  return useCallback(
    (fileId: string) =>
      mutate((state) => ({
        artifactView: { ...state.artifactView, isOpen: true, tab: "files", fileId },
      })),
    [mutate],
  );
}

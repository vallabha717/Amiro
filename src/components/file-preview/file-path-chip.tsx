"use client";

import { workspacePathFrom, previewKindOf } from "lib/file-preview/kinds";
import { cn } from "lib/utils";
import { FileIcon } from "lucide-react";
import type { ReactNode } from "react";
import { useOpenWorkspaceFile } from "./use-open-workspace-file";

/**
 * Inline code that names a workspace file becomes a button that opens it in
 * the Files tab. Anything that is not a path stays ordinary inline code, so
 * `useState` or `v1.2` are never turned into dead links.
 */
export function InlineCode({ children }: { children?: ReactNode }) {
  const open = useOpenWorkspaceFile();
  const text = typeof children === "string" ? children : null;
  const path = text ? workspacePathFrom(text) : null;
  const kind = path ? previewKindOf(path) : null;

  if (!path || kind === null) {
    return (
      <code className="text-sm rounded-md bg-accent text-primary py-0.5 px-1.5 mx-0.5">
        {children}
      </code>
    );
  }
  return (
    <button
      type="button"
      data-testid="chat-file-path"
      data-path={path}
      title={`Open ${path}`}
      onClick={() => open(path)}
      className={cn(
        "mx-0.5 inline-flex max-w-full items-center gap-1 rounded-md bg-accent px-1.5 py-0.5 align-baseline",
        "font-mono text-sm text-primary underline-offset-2 transition-colors",
        "hover:bg-accent/70 hover:underline focus-visible:outline-2 focus-visible:outline-ring",
      )}
    >
      <FileIcon className="size-3 shrink-0" aria-hidden="true" />
      <span className="truncate">{children}</span>
    </button>
  );
}

/** A markdown link whose target is a workspace file opens the viewer instead of a new tab. */
export function useFileLink(href: string | undefined) {
  const open = useOpenWorkspaceFile();
  const path = href && !/^[a-z][a-z0-9+.-]*:/i.test(href) ? workspacePathFrom(decodeURI(href)) : null;
  return path ? () => open(path) : null;
}

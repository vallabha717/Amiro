"use client";

import { memo, useEffect, useRef, useState, ReactNode } from "react";
import {
  TerminalIcon,
  CheckIcon,
  XCircleIcon,
  CopyIcon,
  ChevronDownIcon,
  ChevronRightIcon,
  FolderIcon,
  Maximize2Icon,
} from "lucide-react";
import { Button } from "ui/button";
import { cn } from "lib/utils";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "ui/dialog";

export type TerminalWindowStatus = "pending" | "success" | "error";

export interface TerminalWindowProps {
  command?: string;
  cwd?: string;
  status: TerminalWindowStatus;
  exitCode?: number;
  output?: string;
  emptyText?: string;
  loadingText?: string;
  className?: string;
  /** Collapse the body automatically once status leaves "pending". Defaults to true. */
  autoCollapseOnDone?: boolean;
  /** Hide the maximize-to-dialog affordance (used inside the dialog itself). */
  hideMaximize?: boolean;
  /** Force the body open/closed and disable the internal toggle (used inside the dialog). */
  forceExpanded?: boolean;
  /** Cap on the collapsed/inline body height. */
  maxBodyHeight?: string;
}

function StatusBadge({
  status,
  exitCode,
}: {
  status: TerminalWindowStatus;
  exitCode?: number;
}) {
  if (status === "pending") {
    return (
      <span className="flex items-center gap-1 text-[11px] text-amber-400 bg-amber-950/40 border border-amber-800/50 px-2 py-0.5 rounded shrink-0 whitespace-nowrap">
        <span className="size-2 rounded-full bg-amber-400 animate-ping" />
        <span className="hidden xs:inline">Running...</span>
      </span>
    );
  }
  if (status === "error") {
    return (
      <span className="flex items-center gap-1 text-[11px] text-red-400 bg-red-950/40 border border-red-800/50 px-2 py-0.5 rounded shrink-0 whitespace-nowrap">
        <XCircleIcon className="size-3" />
        Exit {exitCode ?? 1}
      </span>
    );
  }
  return (
    <span className="flex items-center gap-1 text-[11px] text-emerald-400 bg-emerald-950/40 border border-emerald-800/50 px-2 py-0.5 rounded shrink-0 whitespace-nowrap">
      <CheckIcon className="size-3" />
      Done
    </span>
  );
}

function TerminalBody({
  output,
  status,
  emptyText,
  loadingText,
  maxBodyHeight,
  onCopy,
  copied,
}: {
  output?: string;
  status: TerminalWindowStatus;
  emptyText?: string;
  loadingText?: string;
  maxBodyHeight?: string;
  onCopy: () => void;
  copied: boolean;
}) {
  return (
    <div
      className={cn(
        "relative rounded-b-lg bg-zinc-950 border border-t-0 border-zinc-800 p-3 text-zinc-300 overflow-auto scrollbar-thin",
        maxBodyHeight ?? "max-h-[350px]",
      )}
    >
      {output ? (
        <pre className="whitespace-pre-wrap break-all leading-relaxed font-mono text-xs">
          {output}
        </pre>
      ) : status === "pending" ? (
        <div className="text-zinc-500 italic flex items-center gap-2 text-xs">
          <span className="animate-pulse">
            {loadingText ?? "$ executing command..."}
          </span>
        </div>
      ) : (
        <div className="text-zinc-500 italic text-xs">
          {emptyText ?? "(no output)"}
        </div>
      )}

      {output && (
        <div className="sticky float-right top-0 -mt-1 -mr-1">
          <Button
            variant="ghost"
            size="icon"
            className="size-6 bg-zinc-900/80 text-zinc-400 hover:text-zinc-100 hover:bg-zinc-800 border border-zinc-700/50"
            onClick={onCopy}
            title="Copy output"
          >
            {copied ? (
              <CheckIcon className="size-3 text-emerald-400" />
            ) : (
              <CopyIcon className="size-3" />
            )}
          </Button>
        </div>
      )}
    </div>
  );
}

function PureTerminalWindow({
  command,
  cwd,
  status,
  exitCode,
  output,
  emptyText,
  loadingText,
  className,
  autoCollapseOnDone = true,
  hideMaximize,
  forceExpanded,
  maxBodyHeight,
}: TerminalWindowProps) {
  const [copied, setCopied] = useState(false);
  const [expanded, setExpanded] = useState(true);
  const [dialogOpen, setDialogOpen] = useState(false);
  const prevStatus = useRef(status);

  // Collapse the body once execution finishes so completed commands don't
  // clutter the conversation/history with stale output left open.
  useEffect(() => {
    if (
      autoCollapseOnDone &&
      prevStatus.current === "pending" &&
      status !== "pending"
    ) {
      setExpanded(false);
    }
    prevStatus.current = status;
  }, [status, autoCollapseOnDone]);

  const handleCopy = () => {
    if (!output) return;
    navigator.clipboard.writeText(output);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  const isExpanded = forceExpanded ?? expanded;

  return (
    <div className={cn("flex flex-col w-full font-mono text-xs", className)}>
      <div className="flex flex-wrap sm:flex-nowrap items-center gap-x-2 gap-y-1 px-2.5 py-2 rounded-t-lg bg-zinc-900 border border-zinc-800 text-zinc-200">
        {!forceExpanded && (
          <Button
            variant="ghost"
            size="icon"
            className="size-6 text-zinc-400 hover:text-zinc-100 hover:bg-zinc-800 shrink-0 order-1"
            onClick={() => setExpanded((v) => !v)}
          >
            {isExpanded ? (
              <ChevronDownIcon className="size-3.5" />
            ) : (
              <ChevronRightIcon className="size-3.5" />
            )}
          </Button>
        )}

        <TerminalIcon className="size-4 text-emerald-400 shrink-0 order-2" />

        <span
          className="font-semibold text-zinc-100 truncate min-w-0 flex-1 basis-full sm:basis-auto order-4 sm:order-3"
          title={command}
        >
          {command || "Terminal Command"}
        </span>

        {cwd && (
          <span
            className="hidden md:flex items-center gap-1 text-[11px] text-zinc-400 bg-zinc-800/80 px-2 py-0.5 rounded truncate shrink min-w-0 max-w-[35%] order-5"
            title={cwd}
          >
            <FolderIcon className="size-3 shrink-0 text-zinc-400" />
            <span className="truncate">{cwd}</span>
          </span>
        )}

        <div className="flex items-center gap-1 shrink-0 ml-auto order-3 sm:order-6">
          <StatusBadge status={status} exitCode={exitCode} />

          {!hideMaximize && (
            <Button
              variant="ghost"
              size="icon"
              className="size-6 text-zinc-400 hover:text-zinc-100 hover:bg-zinc-800"
              onClick={() => setDialogOpen(true)}
              title="Expand"
            >
              <Maximize2Icon className="size-3.5" />
            </Button>
          )}
        </div>
      </div>

      {isExpanded && (
        <TerminalBody
          output={output}
          status={status}
          emptyText={emptyText}
          loadingText={loadingText}
          maxBodyHeight={maxBodyHeight}
          onCopy={handleCopy}
          copied={copied}
        />
      )}

      {!hideMaximize && (
        <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
          <DialogContent className="w-[95vw] max-w-4xl h-[80vh] flex flex-col p-4 gap-3">
            <DialogHeader>
              <DialogTitle className="flex items-center gap-2 text-sm font-mono truncate">
                <TerminalIcon className="size-4 text-emerald-400 shrink-0" />
                <span className="truncate">
                  {command || "Terminal Command"}
                </span>
              </DialogTitle>
              <DialogDescription className="sr-only">
                Terminal command output
              </DialogDescription>
            </DialogHeader>
            <div className="flex-1 min-h-0 flex flex-col font-mono text-xs">
              <TerminalWindow
                command={command}
                cwd={cwd}
                status={status}
                exitCode={exitCode}
                output={output}
                emptyText={emptyText}
                loadingText={loadingText}
                autoCollapseOnDone={false}
                forceExpanded
                hideMaximize
                maxBodyHeight="flex-1 h-full max-h-none"
                className="flex-1 min-h-0"
              />
            </div>
          </DialogContent>
        </Dialog>
      )}
    </div>
  );
}

export const TerminalWindow = memo(PureTerminalWindow);
TerminalWindow.displayName = "TerminalWindow";

/**
 * Small, non-interactive terminal preview for embedding inside cards (e.g.
 * workflow/chat-graph nodes). Shows just the command line + status and a
 * single-line output peek; clicking anywhere opens the full TerminalWindow
 * in the big popup dialog.
 */
function PureTerminalWindowCompact({
  command,
  cwd,
  status,
  exitCode,
  output,
  emptyText,
  loadingText,
  className,
}: TerminalWindowProps) {
  const [open, setOpen] = useState(false);
  const previewLine = output?.split("\n").find((line) => line.trim()) || "";

  return (
    <>
      <div
        className={cn(
          "flex flex-col w-full font-mono text-[11px] rounded-md overflow-hidden border border-zinc-800 bg-zinc-950 cursor-pointer hover:border-zinc-700 transition-colors",
          className,
        )}
        onClick={(e) => {
          e.stopPropagation();
          setOpen(true);
        }}
        title="Click to expand"
      >
        <div className="flex items-center gap-1.5 px-2 py-1.5 bg-zinc-900">
          <TerminalIcon className="size-3 text-emerald-400 shrink-0" />
          <span className="truncate text-zinc-100 font-medium min-w-0 flex-1">
            {command || "Terminal Command"}
          </span>
          <StatusBadge status={status} exitCode={exitCode} />
        </div>
        <div className="px-2 py-1.5 text-zinc-400 truncate">
          {status === "pending" ? (
            <span className="animate-pulse italic">
              {loadingText ?? "$ executing command..."}
            </span>
          ) : previewLine ? (
            <span className="truncate">{previewLine}</span>
          ) : (
            <span className="italic text-zinc-600">
              {emptyText ?? "(no output)"}
            </span>
          )}
        </div>
      </div>

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent
          className="w-[95vw] max-w-4xl h-[80vh] flex flex-col p-4 gap-3"
          onClick={(e) => e.stopPropagation()}
        >
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2 text-sm font-mono truncate">
              <TerminalIcon className="size-4 text-emerald-400 shrink-0" />
              <span className="truncate">{command || "Terminal Command"}</span>
            </DialogTitle>
            <DialogDescription className="sr-only">
              Terminal command output
            </DialogDescription>
          </DialogHeader>
          <div className="flex-1 min-h-0 flex flex-col font-mono text-xs">
            <TerminalWindow
              command={command}
              cwd={cwd}
              status={status}
              exitCode={exitCode}
              output={output}
              emptyText={emptyText}
              loadingText={loadingText}
              autoCollapseOnDone={false}
              forceExpanded
              hideMaximize
              maxBodyHeight="flex-1 h-full max-h-none"
              className="flex-1 min-h-0"
            />
          </div>
        </DialogContent>
      </Dialog>
    </>
  );
}

export const TerminalWindowCompact = memo(PureTerminalWindowCompact);
TerminalWindowCompact.displayName = "TerminalWindowCompact";

export function TerminalWindowMaximizeTrigger({
  children,
  ...props
}: TerminalWindowProps & { children: ReactNode }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <div className="cursor-pointer" onClick={() => setOpen(true)}>
        {children}
      </div>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="w-[95vw] max-w-4xl h-[80vh] flex flex-col p-4 gap-3">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2 text-sm font-mono truncate">
              <TerminalIcon className="size-4 text-emerald-400 shrink-0" />
              <span className="truncate">
                {props.command || "Terminal Command"}
              </span>
            </DialogTitle>
            <DialogDescription className="sr-only">
              Terminal command output
            </DialogDescription>
          </DialogHeader>
          <div className="flex-1 min-h-0 flex flex-col font-mono text-xs">
            <TerminalWindow
              {...props}
              autoCollapseOnDone={false}
              forceExpanded
              hideMaximize
              maxBodyHeight="flex-1 h-full max-h-none"
              className="flex-1 min-h-0"
            />
          </div>
        </DialogContent>
      </Dialog>
    </>
  );
}

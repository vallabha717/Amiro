"use client";

import { cn } from "lib/utils";
import { GitBranchIcon, TerminalIcon } from "lucide-react";
import { TerminalWindow } from "ui/terminal-window";
import type { PresenterProps, ToolPresenter } from "./types";

/**
 * Presenters for the two tools that run programs: the shell, and git.
 *
 * Both existed before the registry -- the shell rendered through
 * `tool-invocation/terminal-invocation.tsx`, git not at all -- and both are
 * migrated here now because Phase 3 needs their `Compact` view for
 * something the old path could not do: show the user what they are
 * approving *before* it runs. A card that renders only from `output` has
 * nothing to say at approval time, which is exactly when it matters most.
 */

/** First line only, elided. A command line can be arbitrarily long. */
function firstLine(s: string, max = 64) {
  const line = (s ?? "").split("\n")[0] ?? "";
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
}

/* ------------------------------------------------------------------ */
/* run_shell / terminal-execution                                      */
/* ------------------------------------------------------------------ */

/**
 * The command, on its own, in a monospace strip.
 *
 * This is the whole approval decision for a shell call: nothing about the
 * tool's *arguments* helps a user judge `rm -rf build` -- the command text
 * is the thing, and it has to be legible verbatim rather than pretty. So no
 * truncation here, unlike the glance line.
 */
function CommandStrip({
  command,
  cwd,
  tone = "default",
}: {
  command?: string;
  cwd?: string;
  tone?: "default" | "error";
}) {
  return (
    <div
      className={cn(
        "w-full rounded-lg border bg-card overflow-hidden",
        tone === "error" && "border-destructive/50",
      )}
    >
      <div className="flex items-center gap-2 px-3 py-2 border-b bg-muted/40">
        <TerminalIcon className="size-3.5 shrink-0 text-muted-foreground" />
        <span className="text-xs font-medium text-muted-foreground">
          {cwd || "shell"}
        </span>
      </div>
      <pre className="px-3 py-2 font-mono text-xs whitespace-pre-wrap break-all">
        {command || ""}
      </pre>
    </div>
  );
}

const runShell: ToolPresenter = {
  glance: ({ input, output, status }) => {
    const command = firstLine(output?.command ?? input?.command ?? "");
    if (status === "pending") return command || "running a command…";
    if (status === "error") return `⚠ ${command}`;
    const exit = output?.exit_code ?? 0;
    if (output?.timed_out) return `${command} · timed out`;
    return `${command} · exit ${exit}`;
  },
  // Node-sized and approval-sized: the command, and nothing else. Output
  // goes in Expanded, which is where there is room for it.
  Compact: ({ input, output, status }: PresenterProps) => (
    <CommandStrip
      command={output?.command ?? input?.command}
      cwd={output?.cwd}
      tone={status === "error" ? "error" : "default"}
    />
  ),
  // Unchanged from the pre-registry renderer: TerminalWindow already knows
  // nothing about which surface it is in, which was the point of the
  // exercise -- the first tool to need a presenter needed no new
  // presentational component.
  Expanded: ({ input, output, status, errorText }: PresenterProps) => {
    const exitCode = output?.exit_code ?? 0;
    const isError =
      status === "error" || Boolean(output?.error) || (output && exitCode !== 0);
    return (
      <div className="w-full my-2">
        <TerminalWindow
          command={input?.command}
          cwd={output?.cwd}
          status={status === "pending" ? "pending" : isError ? "error" : "success"}
          exitCode={exitCode}
          output={output?.output || errorText || ""}
          sandboxed={output?.sandboxed}
          sandboxBackend={output?.sandbox_backend}
        />
      </div>
    );
  },
};

/* ------------------------------------------------------------------ */
/* git                                                                 */
/* ------------------------------------------------------------------ */

/** `git add -- a.go b.go` → `git add`, for a glance line. */
function gitLabel(input: any, output: any) {
  const sub = output?.subcommand ?? input?.subcommand ?? "";
  return sub ? `git ${sub}` : "git";
}

const git: ToolPresenter = {
  glance: ({ input, output, status }) => {
    const label = gitLabel(input, output);
    if (status === "pending") return `${label}…`;
    if (status === "error") return `⚠ ${label} failed`;

    const paths: string[] = output?.paths ?? input?.paths ?? [];
    const sub = output?.subcommand ?? input?.subcommand;
    if (sub === "commit") {
      // The commit message is what the user actually wants to see here --
      // "git commit" alone says nothing about what was committed.
      const msg = firstLine(input?.message ?? "", 40);
      return msg ? `${label} · ${msg}` : label;
    }
    if (paths.length > 0) {
      return `${label} · ${paths.length} ${paths.length === 1 ? "file" : "files"}`;
    }
    if (output?.exit_code) return `${label} · exit ${output.exit_code}`;
    return label;
  },
  Compact: ({ input, output, status }: PresenterProps) => {
    const paths: string[] = output?.paths ?? input?.paths ?? [];
    return (
      <div
        className={cn(
          "w-full rounded-lg border bg-card overflow-hidden",
          status === "error" && "border-destructive/50",
        )}
      >
        <div className="flex items-center gap-2 px-3 py-2 border-b bg-muted/40">
          <GitBranchIcon className="size-3.5 shrink-0 text-muted-foreground" />
          <span className="text-xs font-medium truncate font-mono">
            {output?.command ?? gitLabel(input, output)}
          </span>
        </div>
        {paths.length > 0 ? (
          <div className="px-3 py-2 flex flex-wrap gap-1">
            {paths.slice(0, 6).map((p) => (
              <span
                key={p}
                className="rounded bg-muted px-1.5 py-0.5 font-mono text-[11px] text-muted-foreground"
              >
                {p}
              </span>
            ))}
            {paths.length > 6 ? (
              <span className="text-[11px] text-muted-foreground">
                +{paths.length - 6} more
              </span>
            ) : null}
          </div>
        ) : null}
        {input?.message ? (
          <div className="px-3 py-2 text-xs border-t">
            <span className="text-muted-foreground">message: </span>
            {firstLine(input.message, 80)}
          </div>
        ) : null}
      </div>
    );
  },
  Expanded: ({ input, output, status, errorText }: PresenterProps) => (
    <div
      className={cn(
        "w-full rounded-lg border bg-card overflow-hidden",
        status === "error" && "border-destructive/50",
      )}
    >
      <div className="flex items-center gap-2 px-3 py-2 border-b bg-muted/40">
        <GitBranchIcon className="size-3.5 shrink-0 text-muted-foreground" />
        <span className="text-xs font-medium truncate font-mono">
          {output?.command ?? gitLabel(input, output)}
        </span>
        {output && output.exit_code !== 0 ? (
          <span className="ml-auto rounded bg-destructive/15 text-destructive px-1.5 py-0.5 text-[11px]">
            exit {output.exit_code}
          </span>
        ) : null}
      </div>
      <div className="px-3 py-2 text-xs">
        {status === "error" ? (
          <pre className="whitespace-pre-wrap break-words text-destructive font-mono">
            {errorText || "failed"}
          </pre>
        ) : status === "pending" ? (
          <span className="text-muted-foreground">running…</span>
        ) : (
          <pre className="max-h-80 overflow-auto whitespace-pre-wrap break-words font-mono leading-relaxed">
            {output?.output || "(no output)"}
          </pre>
        )}
        {output?.truncated ? (
          <div className="mt-2 text-amber-600 dark:text-amber-400">
            output truncated
          </div>
        ) : null}
      </div>
    </div>
  ),
};

export const shellPresenters = {
  run_shell: runShell,
  "terminal-execution": runShell,
  git,
};

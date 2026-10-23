"use client";

import { Button } from "ui/button";
import { Separator } from "ui/separator";
import { cn } from "lib/utils";
import { CheckIcon, ShieldAlertIcon, XIcon } from "lucide-react";
import { getToolPresenter } from "./index";
import type { ToolRunStatus } from "./types";

/**
 * What the backend sent to describe a suspended call, as the
 * `data-tool-approval` message part. Mirrors suspendForApproval in
 * backend-go/internal/api/chat/tool_scheduler.go.
 */
export interface ToolApprovalRequest {
  toolCallId: string;
  toolName: string;
  risk: "read" | "write" | "exec" | "external" | "unclassified";
  reason: string;
  command?: string;
  /** The command contains shell operators, so it may run more than it looks like. */
  compound?: boolean;
}

export type ApprovalScope = "once" | "always";

interface ToolApprovalCardProps {
  request: ToolApprovalRequest;
  /** The tool call's arguments, so the presenter can show what will happen. */
  input: unknown;
  onDecide: (confirm: boolean, scope: ApprovalScope) => void;
  disabled?: boolean;
}

const RISK_LABEL: Record<ToolApprovalRequest["risk"], string> = {
  read: "reads",
  write: "writes to your files",
  exec: "runs a command",
  external: "reaches outside this machine",
  unclassified: "is unclassified",
};

/**
 * The approve / reject card.
 *
 * Its body is the tool's own `Compact` presenter, not a JSON dump of the
 * arguments. That is the entire reason the presenter registry was built in
 * Phase 2 before it was needed: a user approving an `edit_file` has to see
 * the diff they are approving, and a user approving a shell call has to
 * read the literal command. Asking someone to consent to
 * `{"path":"src/x.ts","old_string":"…"}` is asking them to click yes
 * without knowing what they agreed to, which is worse than not asking.
 */
export function ToolApprovalCard({
  request,
  input,
  onDecide,
  disabled,
}: ToolApprovalCardProps) {
  const presenter = getToolPresenter(request.toolName);
  const Body = presenter?.Compact;

  // Pending, because nothing has run: the presenter must render from input
  // alone here, which is the contract its glance/Compact already carry.
  const status: ToolRunStatus = "pending";

  return (
    <div className="w-full rounded-lg border border-amber-500/40 bg-amber-500/5 overflow-hidden">
      <div className="flex items-center gap-2 px-3 py-2 border-b border-amber-500/30">
        <ShieldAlertIcon className="size-3.5 shrink-0 text-amber-600 dark:text-amber-400" />
        <span className="text-xs font-medium">
          Approve <span className="font-mono">{request.toolName}</span>?
        </span>
        <span className="ml-auto text-[11px] text-muted-foreground">
          {RISK_LABEL[request.risk] ?? request.risk}
        </span>
      </div>

      <div className="p-3 space-y-2">
        {Body ? (
          <Body input={input} output={undefined} status={status} />
        ) : (
          // No presenter: show the arguments rather than nothing. This is
          // the fallback the merge gate exists to keep rare, not a licence
          // to skip writing one.
          <pre className="rounded bg-muted px-3 py-2 font-mono text-xs whitespace-pre-wrap break-all max-h-40 overflow-auto">
            {JSON.stringify(input ?? {}, null, 2)}
          </pre>
        )}

        {request.compound ? (
          <div className="flex items-start gap-2 rounded bg-destructive/10 px-2 py-1.5 text-xs text-destructive">
            <span aria-hidden>⚠</span>
            <span>
              This command chains or redirects, so it can do more than the
              first command suggests. Read all of it before approving.
            </span>
          </div>
        ) : null}

        <div className="flex flex-wrap items-center gap-2 pt-1">
          <Button
            size="sm"
            variant="secondary"
            className="rounded-full text-xs"
            disabled={disabled}
            onClick={() => onDecide(true, "once")}
          >
            <CheckIcon />
            Approve
          </Button>
          <Button
            size="sm"
            variant="ghost"
            className="rounded-full text-xs"
            disabled={disabled}
            onClick={() => onDecide(true, "always")}
          >
            {/* "Always" is scoped to this conversation, and for a command
                to that exact command line -- the backend decides which,
                since it is the side that knows the tool's shape. */}
            Always allow{request.command ? " this command" : ""}
          </Button>
          <Separator orientation="vertical" className="h-4" />
          <Button
            size="sm"
            variant="outline"
            className={cn("rounded-full text-xs")}
            disabled={disabled}
            onClick={() => onDecide(false, "once")}
          >
            <XIcon />
            Reject
          </Button>
        </div>

        {request.reason ? (
          <p className="text-[11px] text-muted-foreground">{request.reason}</p>
        ) : null}
      </div>
    </div>
  );
}

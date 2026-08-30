"use client";

import { grantWorkspaceTrust } from "@/lib/backend/workspace-trust-api";
import { ShieldAlert } from "lucide-react";
import { useTranslations } from "next-intl";
import { toast } from "sonner";
import { mutate } from "swr";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "ui/alert-dialog";
import { handleErrorWithToast } from "ui/shared-toast";

/**
 * The trust prompt itself: a human answering "may the agent write to and
 * run commands in this folder?" once, up front, rather than discovering
 * the answer as a stream of refused tool calls.
 *
 * Deliberately its own small dialog rather than a reused ToolApprovalCard:
 * that component's scope vocabulary is "once vs. always for *this tool
 * call*", which doesn't map onto a single yes/no workspace grant --
 * docs/coding-agent-parity/phases/phase-00-workspace-trust-and-rules.md
 * calls for reusing the approval card's *visual language*, not its literal
 * shape, and an AlertDialog styled the same way as every other
 * confirmation in this app is the more honest reading of that.
 */
export function WorkspaceTrustPromptDialog({
  root,
  open,
  onOpenChange,
  onGranted,
}: {
  root: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onGranted: () => void;
}) {
  const t = useTranslations("WorkspaceTrust");

  const handleGrant = async () => {
    try {
      await grantWorkspaceTrust(root);
      toast.success(t("grantedToast"));
      // Flips the cached status immediately so the effect that opened this
      // dialog (useWorkspaceTrustStatus in project-selector.tsx) does not
      // see stale "untrusted" data and reopen it on the next render.
      await mutate(
        `/api/workspace-trust/status?root=${encodeURIComponent(root)}`,
      );
      onGranted();
    } catch (err) {
      handleErrorWithToast(err as Error);
    } finally {
      onOpenChange(false);
    }
  };

  return (
    <AlertDialog open={open} onOpenChange={onOpenChange}>
      <AlertDialogContent data-testid="workspace-trust-prompt">
        <AlertDialogHeader>
          <AlertDialogTitle className="flex items-center gap-2">
            <ShieldAlert className="size-4.5 text-amber-500" />
            {t("promptTitle")}
          </AlertDialogTitle>
          <AlertDialogDescription className="flex flex-col gap-2">
            <span>{t("promptDescription")}</span>
            <code
              className="rounded bg-muted px-2 py-1 text-xs break-all"
              data-testid="workspace-trust-prompt-root"
            >
              {root}
            </code>
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel data-testid="workspace-trust-decline">
            {t("decline")}
          </AlertDialogCancel>
          <AlertDialogAction
            onClick={handleGrant}
            data-testid="workspace-trust-grant"
          >
            {t("grant")}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

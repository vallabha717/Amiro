"use client";

import { useCheckpointFiles } from "@/hooks/queries/use-checkpoint";
import { restoreCheckpoint } from "@/lib/backend/checkpoint-api";
import { FileEdit, FilePlus, History, Loader } from "lucide-react";
import { useTranslations } from "next-intl";
import { useState } from "react";
import { toast } from "sonner";
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
 * The rewind confirmation: exactly which files "Rewind to here" will
 * revert, before anything happens -- the desktop/web half of
 * docs/coding-agent-parity/phases/phase-01-checkpoints-and-rewind.md's
 * deliverable 3.
 *
 * Deliberately its own small dialog rather than a reused ToolApprovalCard,
 * for the same reason WorkspaceTrustPromptDialog is: the approval card's
 * vocabulary is "once vs. always for *this tool call*", which does not
 * describe a rewind. Reusing the approval card's visual language (an
 * AlertDialog styled the same as every other confirmation) is the honest
 * reading of "reuse the approval-card rendering contract" here, matching
 * the terminal's own approach in component/approval.
 */
export function RewindConfirmDialog({
  threadId,
  turnId,
  open,
  onOpenChange,
  onRestored,
}: {
  threadId: string;
  turnId: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onRestored: () => void;
}) {
  const t = useTranslations("Checkpoint");
  const [restoring, setRestoring] = useState(false);
  const { data, isLoading } = useCheckpointFiles(threadId, turnId, open);

  const handleRestore = async () => {
    setRestoring(true);
    try {
      const result = await restoreCheckpoint(threadId, turnId);
      const restored = result.files.filter((f) => f.restored).length;
      const failed = result.files.length - restored;
      if (failed === 0) {
        toast.success(t("restoredToast", { count: restored }));
      } else if (restored === 0) {
        toast.error(t("restoreFailedToast"));
      } else {
        toast.warning(t("restoredPartialToast", { restored, failed }));
      }
      onRestored();
    } catch (err) {
      handleErrorWithToast(err as Error);
    } finally {
      setRestoring(false);
      onOpenChange(false);
    }
  };

  return (
    <AlertDialog open={open} onOpenChange={onOpenChange}>
      <AlertDialogContent data-testid="rewind-confirm-dialog">
        <AlertDialogHeader>
          <AlertDialogTitle className="flex items-center gap-2">
            <History className="size-4.5 text-amber-500" />
            {t("confirmTitle")}
          </AlertDialogTitle>
          <AlertDialogDescription className="flex flex-col gap-2">
            <span>{t("confirmDescription")}</span>
          </AlertDialogDescription>
        </AlertDialogHeader>

        {isLoading ? (
          <div className="flex items-center gap-2 text-sm text-muted-foreground py-2">
            <Loader className="size-4 animate-spin" />
            {t("loading")}
          </div>
        ) : (
          <ul
            data-testid="rewind-confirm-file-list"
            className="flex flex-col gap-1.5 max-h-48 overflow-y-auto rounded-md border bg-muted/30 p-2"
          >
            {(data?.files ?? []).map((f) => (
              <li
                key={f.path}
                className="flex items-center gap-2 text-xs font-mono"
              >
                {f.existedBefore ? (
                  <FileEdit className="size-3.5 shrink-0 text-muted-foreground" />
                ) : (
                  <FilePlus className="size-3.5 shrink-0 text-muted-foreground" />
                )}
                <span className="truncate">{f.path}</span>
                <span className="ml-auto shrink-0 text-[10px] text-muted-foreground">
                  {f.existedBefore ? t("fileModified") : t("fileCreated")}
                </span>
              </li>
            ))}
          </ul>
        )}

        <AlertDialogFooter>
          <AlertDialogCancel data-testid="rewind-cancel" disabled={restoring}>
            {t("cancel")}
          </AlertDialogCancel>
          <AlertDialogAction
            onClick={(e) => {
              e.preventDefault();
              handleRestore();
            }}
            disabled={restoring || isLoading}
            data-testid="rewind-confirm"
          >
            {restoring ? (
              <Loader className="size-4 animate-spin" />
            ) : (
              t("confirm")
            )}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

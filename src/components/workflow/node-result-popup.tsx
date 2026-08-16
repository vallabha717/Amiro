"use client";

import { ReactNode, useMemo, useState } from "react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "ui/dialog";

import { NodeRuntimeHistory } from "lib/ai/workflow/workflow.interface";

import { useCopy } from "@/hooks/use-copy";
import { cn, errorToString } from "lib/utils";
import {
  CheckIcon,
  CopyIcon,
  Loader2Icon,
  TriangleAlertIcon,
} from "lucide-react";
import { useTranslations } from "next-intl";
import { Alert, AlertDescription, AlertTitle } from "ui/alert";
import { Badge } from "ui/badge";
import { Button } from "ui/button";
import JsonView from "ui/json-view";
import { getToolPresenter, statusFromNodeHistory } from "../tool-presenters";

export function NodeResultPopup({
  history,
  children,
  disabled,
  toolName,
}: {
  history: Pick<
    NodeRuntimeHistory,
    "name" | "status" | "startedAt" | "endedAt" | "error" | "result"
  >;
  children: ReactNode;
  disabled?: boolean;
  /**
   * The tool this node ran, when it ran one. Supplying it swaps the raw
   * JSON dump for that tool's own presenter -- the same component chat
   * renders -- and keeps the JSON behind a "raw" tab. Without it the
   * dialog behaves exactly as it always has.
   */
  toolName?: string;
}) {
  const { copy, copied } = useCopy();
  const t = useTranslations();

  const [tab, setTab] = useState<"input" | "output" | "raw">("output");

  const presenter = getToolPresenter(toolName);

  const duration = useMemo(() => {
    if (history.endedAt) {
      return `${((history.endedAt - history.startedAt) / 1000).toFixed(3)}s`;
    }
    return null;
  }, [history.endedAt, history.startedAt]);

  return (
    <Dialog open={disabled ? false : undefined}>
      <DialogTrigger asChild>{children}</DialogTrigger>
      <DialogContent className="min-w-[40vw] h-[70vh] max-w-[40vw] overflow-y-auto flex flex-col">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            {history.name}
          </DialogTitle>
          <DialogDescription className="sr-only">
            {t("Common.result")}
          </DialogDescription>
        </DialogHeader>
        <div className="w-full flex flex-col flex-1">
          <div className="flex items-center text-sm gap-12 my-8">
            <div>
              <p className="mb-2 text-muted-foreground">{t("Common.status")}</p>
              <Badge
                className="font-semibold"
                variant={
                  history.status === "fail"
                    ? "destructive"
                    : history.status === "running"
                      ? "secondary"
                      : "default"
                }
              >
                {history.status === "fail" ? (
                  <TriangleAlertIcon className="size-3" />
                ) : history.status === "running" ? (
                  <Loader2Icon className="size-3 animate-spin" />
                ) : (
                  <CheckIcon className="size-3" />
                )}
                {history.status}
              </Badge>
            </div>
            <div>
              <p className="text-muted-foreground mb-2">
                {t("Common.startedAt")}
              </p>
              <p>{new Date(history.startedAt).toLocaleString()}</p>
            </div>
            <div>
              <p className="text-muted-foreground mb-2">
                {t("Common.duration")}
              </p>
              <p>{history.status === "running" ? "N/A" : duration}</p>
            </div>
          </div>
          <div className="w-full h-full flex flex-col gap-2">
            <div className="flex items-center relative">
              <div className="absolute left-0 top-0 border-b w-full h-full pointer-events-none" />
              <Button
                key="input"
                variant="ghost"
                className={cn(
                  "rounded-none",
                  tab == "input" && "border-b border-primary",
                )}
                onClick={() => setTab("input")}
              >
                input
              </Button>
              <Button
                key="output"
                variant="ghost"
                className={cn(
                  "rounded-none",
                  tab == "output" && "border-b border-primary",
                )}
                onClick={() => setTab("output")}
              >
                output
              </Button>
              {presenter?.Expanded ? (
                <Button
                  key="raw"
                  variant="ghost"
                  className={cn(
                    "rounded-none",
                    tab == "raw" && "border-b border-primary",
                  )}
                  onClick={() => setTab("raw")}
                >
                  raw
                </Button>
              ) : null}
            </div>
            <div className="flex flex-col gap-2 w-full p-4 pt-2 min-w-0">
              {tab == "output" &&
              history.status === "fail" &&
              !presenter ? null : (
                <>
                  <Button
                    variant="ghost"
                    size="icon"
                    className="ml-auto"
                    onClick={() =>
                      copy(
                        JSON.stringify(
                          tab == "input"
                            ? history.result?.input
                            : history.result?.output,
                        ),
                      )
                    }
                  >
                    {copied ? (
                      <CheckIcon className="size-3" />
                    ) : (
                      <CopyIcon className="size-3" />
                    )}
                  </Button>
                </>
              )}
              {tab == "output" && presenter?.Expanded ? (
                <presenter.Expanded
                  input={history.result?.input}
                  output={history.result?.output}
                  status={statusFromNodeHistory(history)}
                  errorText={
                    history.error ? errorToString(history.error) : undefined
                  }
                />
              ) : tab == "output" && history.status === "fail" ? (
                <Alert variant="destructive" className="flex flex-col gap-2">
                  <AlertTitle>Error</AlertTitle>
                  <AlertDescription>
                    {errorToString(history.error)}
                  </AlertDescription>
                </Alert>
              ) : (
                <JsonView
                  initialExpandDepth={4}
                  data={
                    tab == "input"
                      ? history.result?.input
                      : history.result?.output
                  }
                />
              )}
            </div>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}

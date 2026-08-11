"use client";

import { XIcon } from "lucide-react";
import { useTranslations } from "next-intl";
import { Button } from "ui/button";
import { Badge } from "ui/badge";
import JsonView from "ui/json-view";
import { Markdown } from "@/components/markdown";
import { ChatGraphNodeData } from "app-types/chat-graph";

const KIND_LABEL_DISPLAY = {
  prompt: "INPUT",
  llm: "INFO",
  tool: "TOOL CALL",
  chart: "DATA VISUALIZATION",
  code: "CODE EXECUTOR",
  http: "HTTP REQUEST",
  template: "TEMPLATE",
  response: "OUTPUT",
} as const;

export function ChatGraphPanel({
  data,
  onClose,
}: {
  data: ChatGraphNodeData;
  onClose: () => void;
}) {
  const t = useTranslations("Chat.WorkflowView");
  const tCommon = useTranslations("Common");

  const kindDisplay = KIND_LABEL_DISPLAY[data.kind] || data.kind.toUpperCase();

  return (
    <div className="w-80 max-h-[70vh] overflow-y-auto rounded-xl border bg-card shadow-2xl transition-all">
      <div className="flex items-center gap-2 border-b px-4 py-3 bg-muted/30">
        <Badge
          variant="secondary"
          className="font-semibold uppercase tracking-wider text-[10px]"
        >
          {kindDisplay}
        </Badge>
        {data.isMcp && (
          <Badge
            variant="outline"
            className="border-indigo-500/30 text-indigo-500 text-[10px]"
          >
            MCP
          </Badge>
        )}
        <div className="truncate text-sm font-medium">{data.label}</div>
        <Button
          variant="ghost"
          size="icon"
          className="ml-auto size-6"
          onClick={onClose}
        >
          <XIcon className="size-3.5" />
        </Button>
      </div>
      <div className="flex flex-col gap-3.5 p-4 text-xs">
        <div className="flex items-center justify-between">
          <span className="text-muted-foreground font-medium">
            {tCommon("status")}
          </span>
          <Badge
            variant={
              data.status === "fail"
                ? "destructive"
                : data.status === "running"
                  ? "outline"
                  : "default"
            }
            className="capitalize"
          >
            {data.status}
          </Badge>
        </div>

        {data.serverName && (
          <div className="flex items-center justify-between border-t border-border/40 pt-2">
            <span className="text-muted-foreground font-medium">
              MCP Server
            </span>
            <span className="font-mono text-foreground">{data.serverName}</span>
          </div>
        )}

        {(data.kind === "prompt" ||
          data.kind === "response" ||
          data.kind === "llm") &&
          data.text && (
            <div className="border-t border-border/40 pt-2">
              <Markdown>{data.text}</Markdown>
            </div>
          )}

        {data.kind !== "prompt" &&
          data.kind !== "response" &&
          data.kind !== "llm" && (
            <div className="flex flex-col gap-3 border-t border-border/40 pt-2">
              {data.input !== undefined && (
                <div>
                  <div className="mb-1 text-muted-foreground font-medium">
                    {t("input")}
                  </div>
                  <JsonView data={data.input} />
                </div>
              )}
              {data.output !== undefined && (
                <div>
                  <div className="mb-1 text-muted-foreground font-medium">
                    {tCommon("result")}
                  </div>
                  <JsonView data={data.output} />
                </div>
              )}
              {data.errorText && (
                <div className="rounded-md border border-destructive/30 bg-destructive/10 p-2 text-destructive">
                  {data.errorText}
                </div>
              )}
            </div>
          )}
      </div>
    </div>
  );
}

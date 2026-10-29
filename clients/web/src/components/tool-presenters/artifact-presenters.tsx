"use client";

import { FileTextIcon, ImageIcon, Loader2 } from "lucide-react";
import { useTranslations } from "next-intl";
import { Button } from "ui/button";
import { cn } from "lib/utils";
import { kindLabel } from "@/lib/backend/artifacts-api";
import { useArtifactImage } from "@/lib/backend/image-generation-api";
import { useOpenArtifactFile } from "../artifacts/file-artifacts";
import {
  extractOpenUIPayload,
  OpenUISurface,
} from "../openui/openui-surface";
import type { PresenterProps, ToolPresenter } from "./types";

/* ------------------------------------------------------------------ */
/* artifact_create / artifact_update                                     */
/* ------------------------------------------------------------------ */

/**
 * The file record, wherever it survived in the tool result.
 *
 * The agent bridge returns `(text, data)` with `data = {artifact: {...}}`,
 * but the transcript may carry that as a parsed object, nested under
 * `data`/`result`, or flattened into the fenced ```json block the bridge
 * appends to the text. The input always has the title/filename the model
 * asked for, so the card degrades to those rather than to nothing.
 */
export interface ArtifactRef {
  id?: string;
  title?: string;
  filename?: string;
  kind?: string;
  mime?: string;
  size?: number;
}

function asRecord(value: unknown): ArtifactRef | undefined {
  if (!value || typeof value !== "object") return undefined;
  const r = value as Record<string, unknown>;
  if (typeof r.id === "string" || typeof r.filename === "string") {
    return {
      id: typeof r.id === "string" ? r.id : undefined,
      title: typeof r.title === "string" ? r.title : undefined,
      filename: typeof r.filename === "string" ? r.filename : undefined,
      kind: typeof r.kind === "string" ? r.kind : undefined,
      mime: typeof r.mime === "string" ? r.mime : undefined,
      size: typeof r.size === "number" ? r.size : undefined,
    };
  }
  return undefined;
}

export function textsOf(value: unknown, into: string[]): void {
  if (typeof value === "string") {
    into.push(value);
    return;
  }
  if (Array.isArray(value)) {
    for (const v of value) textsOf(v, into);
    return;
  }
  if (value && typeof value === "object") {
    const r = value as Record<string, unknown>;
    if (typeof r.text === "string") into.push(r.text);
    if (typeof r.content !== "undefined") textsOf(r.content, into);
  }
}

export function extractArtifact(input: any, output: any): ArtifactRef | undefined {
  for (const c of [output?.artifact, output?.data?.artifact, output?.result?.artifact]) {
    const found = asRecord(c);
    if (found) return found;
  }
  const strings: string[] = [];
  textsOf(output, strings);
  for (const s of strings) {
    const fence = /```json\s*([\s\S]*?)```/.exec(s);
    const candidates = [fence?.[1], s];
    for (const raw of candidates) {
      if (!raw) continue;
      try {
        const parsed = JSON.parse(raw.trim());
        const found = asRecord(parsed?.artifact) ?? asRecord(parsed);
        if (found) return found;
      } catch {
        // Not JSON — keep scanning.
      }
    }
  }
  const fallback = asRecord({ ...input, id: undefined });
  if (fallback && (fallback.title || fallback.filename)) return fallback;
  return undefined;
}

function ArtifactCard({ input, output, status, verb }: PresenterProps & { verb: "created" | "updated" }) {
  const t = useTranslations("Chat.Artifact");
  const openFile = useOpenArtifactFile();
  const ref = extractArtifact(input, output);
  const title = ref?.title || (input?.title as string) || "Artifact";
  return (
    <div
      className={cn(
        "w-full overflow-hidden rounded-lg border bg-card",
        status === "error" && "border-destructive/50",
      )}
    >
      <div className="flex items-center gap-2 border-b bg-muted/40 px-3 py-2">
        <FileTextIcon className="size-3.5 shrink-0 text-muted-foreground" />
        <span className="truncate text-xs font-medium">{title}</span>
        {ref?.kind && (
          <span className="shrink-0 rounded bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground">
            {kindLabel(ref.kind)}
          </span>
        )}
        {ref?.id && status === "success" && (
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="ml-auto h-7 shrink-0 text-xs"
            data-testid={`artifact-open-${ref.id}`}
            onClick={() => openFile(ref.id as string)}
          >
            {t("open")}
          </Button>
        )}
      </div>
      <div className="px-3 py-2 text-[11px] text-muted-foreground">
        {[ref?.filename, verb === "updated" ? t("fileUpdated") : undefined]
          .filter(Boolean)
          .join(" · ") || "…"}
      </div>
    </div>
  );
}

const artifactCreate: ToolPresenter = {
  glance: ({ input, output, status }) => {
    if (status === "error") return "⚠ artifact failed";
    const ref = extractArtifact(input, output);
    const title = ref?.title || (input?.title as string) || "artifact";
    return `artifact · ${title}`;
  },
  Compact: (props) => <ArtifactCard {...props} verb="created" />,
};

artifactCreate.Expanded = artifactCreate.Compact;

const artifactUpdate: ToolPresenter = {
  glance: ({ input, output, status }) => {
    if (status === "error") return "⚠ artifact update failed";
    const ref = extractArtifact(input, output);
    const title = ref?.title || (input?.title as string) || "artifact";
    return `artifact updated · ${title}`;
  },
  Compact: (props) => <ArtifactCard {...props} verb="updated" />,
};

artifactUpdate.Expanded = artifactUpdate.Compact;

/** A picture the agent drew: shown inline, opens in Files. */
function ImageCard({ input, output, status, errorText }: PresenterProps) {
  const t = useTranslations("ImageGeneration");
  const tArtifact = useTranslations("Chat.Artifact");
  const openFile = useOpenArtifactFile();
  const ref = status === "success" ? extractArtifact({}, output) : undefined;
  const id = typeof ref?.id === "string" ? ref.id : undefined;
  const src = useArtifactImage(id);
  const prompt = typeof input?.prompt === "string" ? input.prompt : "";
  return (
    <div
      className={cn(
        "w-full overflow-hidden rounded-lg border bg-card",
        status === "error" && "border-destructive/50",
      )}
      data-testid="image-generate-card"
      data-status={status}
    >
      <div className="flex items-center gap-2 border-b bg-muted/40 px-3 py-2">
        <ImageIcon className="size-3.5 shrink-0 text-muted-foreground" />
        <span className="truncate text-xs font-medium">
          {status === "pending"
            ? t("toolDrawing")
            : status === "error"
              ? t("toolFailed")
              : (ref?.title as string) || t("toolDrew")}
        </span>
        {id && (
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="ml-auto h-7 shrink-0 text-xs"
            onClick={() => openFile(id)}
          >
            {tArtifact("open")}
          </Button>
        )}
      </div>
      <div className="p-2">
        {status === "pending" && (
          <div className="flex items-center gap-2 px-1 py-6 text-xs text-muted-foreground">
            <Loader2 className="size-4 animate-spin" />
            {prompt}
          </div>
        )}
        {status === "error" && (
          <p className="px-1 py-2 text-xs text-destructive">{errorText}</p>
        )}
        {status === "success" &&
          (src ? (
            <img
              src={src}
              alt={prompt || (ref?.title as string) || ""}
              className="max-h-[28rem] w-auto rounded-md"
              data-testid="image-generate-picture"
            />
          ) : (
            <Loader2 className="m-2 size-4 animate-spin" />
          ))}
      </div>
    </div>
  );
}

/**
 * The arguments of an `image_generate` call, whether the model called it
 * directly (`mcp__amiro__image_generate`) or through the runtime's `mcp_call`
 * wrapper; undefined for any other tool.
 */
export function imageGenerateArgs(toolName: string, input: any): any | undefined {
  const bare = toolName.replace(/^mcp__amiro__|^amiro__|^amiro_/, "");
  if (bare === "image_generate") return input ?? {};
  if (toolName === "mcp_call") {
    const target = mcpArtifactTarget(input);
    if (target?.tool === "image_generate") return target.args ?? {};
  }
  return undefined;
}

/** A drawn picture as its own card, for the transcript outside the fold. */
export function DrawnImage(props: PresenterProps) {
  return <ImageCard {...props} />;
}

export const imageGenerate: ToolPresenter = {
  glance: ({ input, status }) => {
    const prompt = typeof input?.prompt === "string" ? input.prompt.slice(0, 40) : "";
    if (status === "error") return "⚠ image failed";
    if (status === "pending") return `drawing · ${prompt}…`;
    return `image · ${prompt}`;
  },
  Compact: ImageCard,
};

imageGenerate.Expanded = imageGenerate.Compact;

const artifactDelete: ToolPresenter = {
  glance: ({ status }) =>
    status === "error" ? "⚠ artifact delete failed" : "artifact deleted",
};

const uiRenderOpenUI: ToolPresenter = {
  glance: ({ input, output, status }) => {
    if (status === "error") return "⚠ openui failed";
    const payload = extractOpenUIPayload(input, output);
    const title = payload?.title || (input?.title as string) || "interactive ui";
    if (status === "pending") return `openui (${title})…`;
    return `openui · ${title}`;
  },
  Compact: ({ input, output, status }: PresenterProps) => {
    const payload = extractOpenUIPayload(input, output);
    if (!payload) return null;
    return (
      <OpenUISurface
        code={payload.code}
        title={payload.title}
        preset={payload.preset}
        isStreaming={status === "pending"}
      />
    );
  },
};

uiRenderOpenUI.Expanded = uiRenderOpenUI.Compact;

/* ------------------------------------------------------------------ */
/* mcp_call (the runtime's MCP dispatch wrapper)                        */
/* ------------------------------------------------------------------ */

/**
 * The model never calls artifact_create directly: the runtime exposes MCP
 * servers through one dispatch tool, so the transcript part is
 * tool-mcp_call with {server, tool, arguments}. Without this entry the
 * agent can save an artifact and the chat shows a bare "mcp_call" row with
 * no card and no way into the Files view.
 */
function mcpArtifactTarget(input: any): { tool: string; args: any } | undefined {
  const server = input?.server;
  const tool = input?.tool;
  if (typeof server !== "string" || typeof tool !== "string") return undefined;
  if (server !== "amiro") return undefined;
  const bare = tool.startsWith("mcp__amiro__")
    ? tool.slice("mcp__amiro__".length)
    : tool.startsWith("amiro__")
      ? tool.slice("amiro__".length)
      : tool.startsWith("amiro_")
        ? tool.slice("amiro_".length)
        : tool;
  if (
    ![
      "artifact_create",
      "artifact_update",
      "artifact_delete",
      "ui_render_openui",
      "image_generate",
    ].includes(bare)
  ) {
    return undefined;
  }
  return { tool: bare, args: input?.arguments };
}

function mcpArtifactVerb(tool: string): "created" | "updated" {
  return tool === "artifact_update" ? "updated" : "created";
}

/**
 * Wrap the generic MCP dispatch card: artifact operations render the file
 * card with its Open button, everything else keeps the base card.
 */
export function withArtifactMcpCard(base: ToolPresenter): ToolPresenter {
  const glance: ToolPresenter["glance"] = (props) => {
    const target = mcpArtifactTarget(props.input);
    if (!target) return base.glance(props);
    const adapted = { input: target.args, output: props.output, status: props.status };
    if (target.tool === "ui_render_openui") {
      return uiRenderOpenUI.glance(adapted as PresenterProps);
    }
    if (target.tool === "image_generate") {
      return imageGenerate.glance(adapted as PresenterProps);
    }
    if (target.tool === "artifact_delete") {
      return artifactDelete.glance(adapted as PresenterProps);
    }
    const specific =
      target.tool === "artifact_update" ? artifactUpdate : artifactCreate;
    return specific.glance(adapted as PresenterProps);
  };
  const Compact: NonNullable<ToolPresenter["Compact"]> = (props) => {
    const target = mcpArtifactTarget(props.input);
    if (!target || target.tool === "artifact_delete") {
      return base.Compact ? base.Compact(props) : null;
    }
    if (target.tool === "ui_render_openui") {
      return uiRenderOpenUI.Compact
        ? uiRenderOpenUI.Compact({
            ...props,
            input: target.args,
          })
        : null;
    }
    if (target.tool === "image_generate") {
      return <ImageCard {...props} input={target.args} />;
    }
    return (
      <ArtifactCard
        input={target.args}
        output={props.output}
        status={props.status}
        verb={mcpArtifactVerb(target.tool)}
      />
    );
  };
  const Expanded: NonNullable<ToolPresenter["Expanded"]> = (props) => {
    const target = mcpArtifactTarget(props.input);
    if (!target || target.tool === "artifact_delete") {
      return base.Expanded ? base.Expanded(props) : null;
    }
    if (target.tool === "ui_render_openui") {
      return uiRenderOpenUI.Expanded
        ? uiRenderOpenUI.Expanded({
            ...props,
            input: target.args,
          })
        : null;
    }
    if (target.tool === "image_generate") {
      return <ImageCard {...props} input={target.args} />;
    }
    return (
      <ArtifactCard
        input={target.args}
        output={props.output}
        status={props.status}
        verb={mcpArtifactVerb(target.tool)}
      />
    );
  };
  return { glance, Compact, Expanded };
}

export const artifactPresenters = {
  artifact_create: artifactCreate,
  artifact_update: artifactUpdate,
  artifact_delete: artifactDelete,
  ui_render_openui: uiRenderOpenUI,
  image_generate: imageGenerate,
};

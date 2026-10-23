"use client";

import { useEffect, useId, useMemo, useRef, useState } from "react";

import {
  injectWidgetBridge,
  isRelayableExternalHref,
} from "@/lib/visual/sandbox-bridge";
import {
  buildWidgetStyle,
  detectColorScheme,
} from "@/lib/visual/widget-tokens";

/** Bounds on the widget-reported height, so a runaway report can't take over
 *  the transcript or collapse the frame to nothing. */
const MIN_HEIGHT = 80;
const MAX_HEIGHT = 1400;
const DEFAULT_HEIGHT = 300;

function clampHeight(height: number): number {
  return Math.min(MAX_HEIGHT, Math.max(MIN_HEIGHT, Math.round(height)));
}

/** Stable 32-bit hash of a string, used to remount the iframe when the document
 *  it renders changes. */
function hashString(value: string): number {
  let hash = 0;
  for (let i = 0; i < value.length; i++) {
    hash = ((hash << 5) - hash + value.charCodeAt(i)) | 0;
  }
  return hash;
}

export interface VisualSurfaceProps {
  /** The self-contained HTML fragment the assistant authored. */
  html: string;
  /** Rough pixel estimate of the content height (80..1400). */
  height?: number;
  /** Accessible frame title. */
  title?: string;
  /** Identifier echoed back by the widget bridge so messages can be matched. */
  surfaceId?: string;
  /**
   * Called with a follow-up prompt the widget handed back through
   * `sendPrompt(text)`. When omitted, a `amiro:send-prompt` window event is
   * dispatched with `detail.prompt` instead.
   */
  onSendPrompt?: (prompt: string) => void;
}

/**
 * Renders a `visual` surface — a self-contained illustration (SVG diagram,
 * styled table, small interactive explainer) the assistant emits inline.
 *
 * The HTML is untrusted, so it runs inside a `srcdoc` iframe sandboxed without
 * `allow-same-origin`. Two things make it read as native rather than as an
 * embedded document: the host's resolved design tokens are injected as a
 * `:root` block, and the widget reports its own content height so the frame has
 * no scrollbar and no dead space.
 *
 * The widget can hand a follow-up back to the assistant via `sendPrompt(text)`
 * (or `window.applet.sendPrompt`). The parent honors it only under an active
 * user activation and forwards it to `onSendPrompt`, or dispatches an
 * `amiro:send-prompt` event when no handler is supplied.
 *
 * The frame gets no popup tokens, so every outbound link arrives here as a
 * `vellum_open_link` relay the host opens after checking its scheme. Treat the
 * surface as able to egress on any click the user makes inside it.
 */
export function VisualSurface({
  html,
  height,
  title,
  surfaceId,
  onSendPrompt,
}: VisualSurfaceProps) {
  const reactId = useId();
  const frameId = surfaceId ?? `visual-${reactId}`;
  const iframeRef = useRef<HTMLIFrameElement>(null);

  // Token snapshot lives in state rather than a render-time memo: the live
  // document is unreadable during SSR, and computing it in an effect keeps the
  // server and first client render identical (both show the placeholder) before
  // the themed frame mounts. It is re-probed whenever the host flips theme.
  const [tokenStyle, setTokenStyle] = useState("");

  useEffect(() => {
    const root = document.documentElement;
    const sync = () => {
      const scheme = detectColorScheme(root);
      setTokenStyle(buildWidgetStyle(scheme, root).style);
    };
    sync();
    const observer = new MutationObserver(sync);
    observer.observe(root, {
      attributes: true,
      attributeFilter: ["class", "data-theme"],
    });
    return () => observer.disconnect();
  }, []);

  const initialHeight = clampHeight(
    typeof height === "number" && Number.isFinite(height)
      ? height
      : DEFAULT_HEIGHT,
  );

  const srcDoc = useMemo(
    () => injectWidgetBridge(html, frameId, tokenStyle),
    [html, frameId, tokenStyle],
  );

  // Keyed on the exact document the frame renders, so every input baked into
  // `srcdoc` (markup, theme tokens) remounts it. React reuses an iframe element
  // across `srcDoc` changes, and a reused frame keeps the old document's scroll
  // and script state — hashing the document itself is what makes "srcdoc
  // changed" and "frame remounted" the same event.
  const iframeKey = `visual-${frameId}-${hashString(srcDoc)}`;

  // Height belongs to the mounted document, so a remount restarts from the
  // surface's declared height instead of inheriting the previous widget's.
  const [heightState, setHeightState] = useState({
    key: iframeKey,
    height: initialHeight,
  });
  if (heightState.key !== iframeKey) {
    setHeightState({ key: iframeKey, height: initialHeight });
  }

  useEffect(() => {
    const handler = (event: MessageEvent) => {
      const msg = event.data;
      if (!msg || msg.frameId !== frameId) {
        return;
      }
      if (event.source !== iframeRef.current?.contentWindow) {
        return;
      }
      if (msg.type === "vellum_widget_height") {
        const reported = Number(msg.height);
        if (!Number.isFinite(reported)) {
          return;
        }
        const next = clampHeight(reported);
        setHeightState((prev) =>
          prev.height === next ? prev : { ...prev, height: next },
        );
        return;
      }
      if (msg.type === "vellum_widget_prompt") {
        // A sandboxed widget can read its own frameId and post without a
        // click, so the relay is gated on a transient user activation. When the
        // API is unavailable the relay is allowed through rather than silently
        // dropping every prompt.
        const activation =
          typeof navigator !== "undefined"
            ? navigator.userActivation
            : undefined;
        if (activation && !activation.isActive) {
          return;
        }
        const prompt = typeof msg.prompt === "string" ? msg.prompt.trim() : "";
        if (!prompt) {
          return;
        }
        if (onSendPrompt) {
          onSendPrompt(prompt);
        } else if (typeof window !== "undefined") {
          window.dispatchEvent(
            new CustomEvent("amiro:send-prompt", { detail: { prompt } }),
          );
        }
        return;
      }
      if (msg.type === "applet_action") {
        if (typeof window !== "undefined") {
          window.dispatchEvent(
            new CustomEvent("amiro:applet-action", {
              detail: { action: msg.action, args: msg.args },
            }),
          );
        }
        return;
      }
      if (msg.type === "vellum_open_link") {
        const activation =
          typeof navigator !== "undefined"
            ? navigator.userActivation
            : undefined;
        if (activation && !activation.isActive) {
          return;
        }
        if (!isRelayableExternalHref(msg.href)) {
          return;
        }
        window.open(msg.href.trim(), "_blank", "noopener,noreferrer");
      }
    };

    window.addEventListener("message", handler);
    return () => window.removeEventListener("message", handler);
  }, [frameId, onSendPrompt]);

  if (!html) {
    return null;
  }

  if (!tokenStyle) {
    return <VisualPlaceholder title={title} height={initialHeight} />;
  }

  return (
    <div className="w-full overflow-hidden rounded-lg">
      <iframe
        ref={iframeRef}
        key={iframeKey}
        srcDoc={srcDoc}
        sandbox="allow-scripts"
        referrerPolicy="no-referrer"
        title={title || "Visual"}
        style={{
          width: "100%",
          height: `${heightState.height}px`,
          border: "none",
          display: "block",
        }}
      />
    </div>
  );
}

/**
 * Shown in place of a visual while its token snapshot is still being probed,
 * or while a visual tool call is still streaming (`status === "pending"`).
 */
export function VisualPlaceholder({
  title,
  height,
}: {
  title?: string;
  height?: number;
}) {
  return (
    <div
      className="w-full animate-pulse rounded-lg border border-border/60 bg-muted/30"
      style={{ height: `${clampHeight(height ?? DEFAULT_HEIGHT)}px` }}
      role="status"
      aria-label={title || "Rendering visual"}
    />
  );
}

// ---------------------------------------------------------------------------
// Inline text parsing
// ---------------------------------------------------------------------------

export type InlineVisualSegment =
  | { type: "text"; content: string }
  | {
      type: "visual";
      html: string;
      height?: number;
      title?: string;
      id: string;
    }
  | {
      type: "openui";
      code: string;
      title?: string;
      preset?: string;
      streaming?: boolean;
      id: string;
    };

const VISUAL_BLOCK_RE =
  /<ui_show\s*([^>]*?)>([\s\S]*?)<\/ui_show>|```visual(?=[\s{]|$)[^\n]*\n([\s\S]*?)```|```(?:openui|openui-lang)(?=[\s{]|$)([^\n]*)\n([\s\S]*?)(?:```|$)/g;

const ATTR_RE = /([\w-]+)\s*=\s*"([^"]*)"/g;

let inlineVisualCounter = 0;

function readAttributes(source: string): Record<string, string> {
  const attrs: Record<string, string> = {};
  ATTR_RE.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = ATTR_RE.exec(source)) !== null) {
    attrs[match[1]] = match[2];
  }
  return attrs;
}

/**
 * Parse one block body into a visual payload. The body is either a JSON object
 * (`{"html": "...", "height": 320, "title": "..."}`, or with `source` in place
 * of `html`) or the raw HTML fragment itself.
 */
/**
 * Best-effort read of `{"html": "...", "height": N, "title": "..."}` whose
 * html value has unescaped quotes: take everything from the opening quote
 * after "html": up to the last quote before the trailing keys or brace.
 */
export function salvageVisualJson(body: string): Record<string, unknown> | null {
  const start = body.match(/"(html|source)"\s*:\s*"/);
  if (!start || start.index === undefined) return null;
  const from = start.index + start[0].length;
  const rest = body.slice(from);
  const tail = rest.match(/"\s*(,\s*"(height|title)"\s*:[\s\S]*)?}\s*$/);
  if (!tail || tail.index === undefined) return null;
  const html = rest
    .slice(0, tail.index)
    .replace(/\\"/g, '"')
    .replace(/\\n/g, "\n")
    .replace(/\\\\/g, "\\");
  if (!html.trim()) return null;
  const height = body.match(/"height"\s*:\s*(\d+)/);
  const title = body.match(/"title"\s*:\s*"([^"]*)"/);
  return {
    html,
    ...(height ? { height: Number(height[1]) } : {}),
    ...(title ? { title: title[1] } : {}),
  };
}

function parseVisualPayload(
  raw: string,
): { html: string; height?: number; title?: string } | null {
  const body = raw.trim();
  if (!body) {
    return null;
  }

  if (body.startsWith("{")) {
    let data: Record<string, unknown>;
    try {
      data = JSON.parse(body) as Record<string, unknown>;
    } catch {
      // Models often forget to escape the quotes inside the HTML string.
      // Recover it rather than dumping the raw tag into the reply.
      const salvaged = salvageVisualJson(body);
      if (!salvaged) return null;
      data = salvaged;
    }
    const html =
      typeof data.html === "string"
        ? data.html
        : typeof data.source === "string"
          ? data.source
          : "";
    if (!html) {
      return null;
    }
    return {
      html,
      height:
        typeof data.height === "number" && Number.isFinite(data.height)
          ? data.height
          : undefined,
      title: typeof data.title === "string" ? data.title : undefined,
    };
  }

  return { html: body };
}

/**
 * Parse `<ui_show surface_type="visual">…</ui_show>` tags and ```` ```visual ````
 * fenced blocks embedded in assistant markdown into text and visual segments.
 *
 * Returns `null` when no visual block is found so callers can skip the
 * overhead. A `<ui_show>` tag whose `surface_type` is not `visual` is left in
 * place as text — this parser owns visuals only.
 */
export function parseInlineVisuals(text: string): InlineVisualSegment[] | null {
  if (!text) {
    return null;
  }

  VISUAL_BLOCK_RE.lastIndex = 0;

  const segments: InlineVisualSegment[] = [];
  let lastIndex = 0;
  let found = false;
  let match: RegExpExecArray | null;

  while ((match = VISUAL_BLOCK_RE.exec(text)) !== null) {
    const isUiShow = match[2] !== undefined;
    const isOpenUIFence = match[5] !== undefined;

    if (isOpenUIFence) {
      const fenceMeta = (match[4] ?? "").trim();
      const rawCode = (match[5] ?? "").trim();
      if (!rawCode) {
        continue;
      }
      if (match.index > lastIndex) {
        segments.push({
          type: "text",
          content: text.slice(lastIndex, match.index),
        });
      }
      const attrs = readAttributes(fenceMeta);
      const isClosed = match[0].endsWith("```");
      segments.push({
        type: "openui",
        code: rawCode,
        title: attrs.title || undefined,
        preset: attrs.preset || undefined,
        streaming: !isClosed,
        id: `inline-openui-${++inlineVisualCounter}`,
      });
      found = true;
      lastIndex = VISUAL_BLOCK_RE.lastIndex;
      continue;
    }

    const payloadRaw = isUiShow ? match[2] : match[3];

    if (isUiShow) {
      const attrs = readAttributes(match[1]);
      if (attrs.surface_type === "openui") {
        const rawCode = payloadRaw.trim();
        if (!rawCode) continue;
        if (match.index > lastIndex) {
          segments.push({
            type: "text",
            content: text.slice(lastIndex, match.index),
          });
        }
        segments.push({
          type: "openui",
          code: rawCode,
          title: attrs.title || undefined,
          preset: attrs.preset || undefined,
          streaming: false,
          id: `inline-openui-${++inlineVisualCounter}`,
        });
        found = true;
        lastIndex = VISUAL_BLOCK_RE.lastIndex;
        continue;
      }
      if (attrs.surface_type && attrs.surface_type !== "visual") {
        // A different surface type: leave the tag in the flowing text.
        continue;
      }
    }

    let payload: { html: string; height?: number; title?: string } | null;
    if (isUiShow) {
      const attrs = readAttributes(match[1]);
      payload = parseVisualPayload(payloadRaw);
      if (payload) {
        if (!payload.title && attrs.title) {
          payload.title = attrs.title;
        }
        if (payload.height === undefined && attrs.height) {
          const parsed = Number(attrs.height);
          if (Number.isFinite(parsed)) {
            payload.height = parsed;
          }
        }
      }
    } else {
      payload = parseVisualPayload(payloadRaw);
    }

    if (!payload) {
      continue;
    }

    if (match.index > lastIndex) {
      segments.push({
        type: "text",
        content: text.slice(lastIndex, match.index),
      });
    }

    segments.push({
      type: "visual",
      html: payload.html,
      height: payload.height,
      title: payload.title,
      id: `inline-visual-${++inlineVisualCounter}`,
    });
    found = true;
    lastIndex = VISUAL_BLOCK_RE.lastIndex;
  }

  if (!found) {
    return null;
  }

  if (lastIndex < text.length) {
    segments.push({ type: "text", content: text.slice(lastIndex) });
  }

  return segments;
}

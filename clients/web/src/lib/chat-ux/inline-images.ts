/**
 * Pull renderable images out of a tool result so the transcript can show
 * them inline, the way Claude Code does for screenshots, instead of a wall
 * of base64.
 *
 * Tool outputs arrive in many shapes and none of them is "an image": MCP's
 * `{content:[{type:"image",data,mimeType}]}`, the AI SDK's
 * `{type:"content",value:[{type:"media",data,mediaType}]}`, the image tool's
 * `{images:[{url}]}`, a screenshot path or URL inside a string, a markdown
 * `![](...)`. So this walks the value instead of matching a schema, bounded
 * in depth and count so a huge result cannot stall a render.
 */

export interface InlineImage {
  src: string;
  alt?: string;
}

const MAX_DEPTH = 6;
const MAX_IMAGES = 12;
const IMAGE_URL = /^https?:\/\/\S+\.(png|jpe?g|gif|webp|svg|avif)(\?\S*)?$/i;
const DATA_URL = /^data:image\/[a-z0-9.+-]+;base64,/i;
const MARKDOWN_IMAGE = /!\[([^\]]*)\]\((\S+?)\)/g;
// A data URL embedded in other text -- a shell command or screenshot tool
// that prints one after its log lines. Capped so a runaway blob is skipped
// rather than copied into the DOM.
const EMBEDDED_DATA_URL = /data:image\/[a-z0-9.+-]+;base64,[A-Za-z0-9+/]{16,4000000}={0,2}/gi;
const BARE_URL = /(https?:\/\/[^\s"')]+\.(?:png|jpe?g|gif|webp|svg|avif)(?:\?[^\s"')]*)?)/gi;

function asDataUrl(data: string, mime: string | undefined): string {
  if (DATA_URL.test(data)) return data;
  return `data:${mime || "image/png"};base64,${data}`;
}

function isImageMime(m: unknown): m is string {
  return typeof m === "string" && m.toLowerCase().startsWith("image/");
}

export function extractInlineImages(value: unknown): InlineImage[] {
  const out: InlineImage[] = [];
  const seen = new Set<string>();
  const push = (src: string, alt?: string) => {
    if (out.length >= MAX_IMAGES || seen.has(src)) return;
    seen.add(src);
    out.push({ src, alt });
  };

  const visitString = (s: string) => {
    const t = s.trim();
    if (DATA_URL.test(t)) return push(t);
    if (IMAGE_URL.test(t)) return push(t);
    // Long strings are almost always logs or file bodies; only scan them
    // for explicit image references, never treat them as base64.
    for (const m of t.matchAll(MARKDOWN_IMAGE)) {
      if (DATA_URL.test(m[2]) || /^https?:\/\//.test(m[2])) push(m[2], m[1] || undefined);
    }
    for (const m of t.matchAll(BARE_URL)) push(m[1]);
    for (const m of t.matchAll(EMBEDDED_DATA_URL)) push(m[0]);
  };

  const visit = (v: unknown, depth: number) => {
    if (out.length >= MAX_IMAGES || depth > MAX_DEPTH || v == null) return;
    if (typeof v === "string") return visitString(v);
    if (Array.isArray(v)) {
      for (const item of v) visit(item, depth + 1);
      return;
    }
    if (typeof v !== "object") return;
    const o = v as Record<string, any>;

    // MCP image content / AI SDK media content.
    if ((o.type === "image" || o.type === "media") && typeof o.data === "string") {
      const mime = o.mimeType ?? o.mediaType;
      if (o.type === "image" || isImageMime(mime)) {
        push(asDataUrl(o.data, mime), o.alt);
        return;
      }
    }
    // AI SDK file part / generic {url, mediaType}.
    if (typeof o.url === "string" && (isImageMime(o.mediaType ?? o.mimeType) || IMAGE_URL.test(o.url) || DATA_URL.test(o.url))) {
      push(o.url, o.alt ?? o.filename ?? o.title);
      return;
    }
    if (typeof o.image_url === "string") push(o.image_url);
    if (typeof o.image_url?.url === "string") push(o.image_url.url);
    if (typeof o.base64 === "string" && isImageMime(o.mimeType ?? o.mediaType ?? "image/png")) {
      push(asDataUrl(o.base64, o.mimeType ?? o.mediaType));
    }
    for (const [k, child] of Object.entries(o)) {
      // Raw blobs were handled above; scanning them as text finds nothing.
      if ((k === "data" || k === "base64") && typeof child === "string") continue;
      visit(child, depth + 1);
    }
  };

  visit(value, 0);
  return out;
}

const BARE_DATA_IMAGE =
  /(^|[\s(>])(data:image\/(?:png|jpe?g|gif|webp|avif);base64,[A-Za-z0-9+/]{32,}={0,2})(?=$|[\s)<])/gim;

/**
 * Turn bare image data URLs in one markdown block into image syntax, so a
 * model that prints `data:image/png;base64,...` in its reply shows a picture
 * instead of a wall of base64. Fenced code is left alone (that is source the
 * user asked to see), as is anything already written as `![...](...)`.
 * SVG is deliberately excluded: an SVG data URL can carry script.
 */
export function linkifyDataImages(block: string): string {
  if (/^\s{0,3}(```|~~~)/.test(block)) return block;
  if (!block.includes("data:image/")) return block;
  return block.replace(BARE_DATA_IMAGE, (match, lead: string, url: string, offset: number, whole: string) =>
    whole.slice(Math.max(0, offset + lead.length - 2), offset + lead.length) === "](" ? match : `${lead}![image](${url})`,
  );
}

/** Image URLs a renderer may load: http(s) and raster data URLs only. */
export function isSafeImageSrc(url: string): boolean {
  return /^https?:\/\//i.test(url) || /^data:image\/(png|jpe?g|gif|webp|avif);base64,/i.test(url);
}

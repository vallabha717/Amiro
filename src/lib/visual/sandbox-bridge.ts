/**
 * Sandboxed iframe bridge utilities.
 *
 * Provides everything needed to safely render untrusted HTML inside
 * `<iframe sandbox="allow-scripts">` (no `allow-same-origin`):
 *
 * 1. **Storage polyfill** — in-memory shim for `localStorage` / `sessionStorage`,
 *    which throw `SecurityError` in sandboxed contexts without `allow-same-origin`.
 * 2. **Link interceptor** — catches clicks on `<a>` elements and opens them in
 *    new tabs (or relays them to the parent), because a frame sandboxed without
 *    `allow-top-navigation` cannot navigate the host page itself.
 * 3. **Safe injection** — `injectScript()` / `prependScript()` insert `<script>`
 *    tags using `lastIndexOf` so an app's own literal close-tag sequences cannot
 *    hijack the injection site.
 * 4. **Widget bridge** — the reduced surface for inline visuals: an auto-height
 *    reporter, a shrink-to-fit pass and a `sendPrompt(text)` global (plus the
 *    `window.applet` alias), composed by `injectWidgetBridge()`.
 *
 * All sandboxed iframes that render untrusted HTML must use these utilities.
 * The storage polyfill is required even for non-interactive preview iframes.
 *
 * @see https://developer.mozilla.org/en-US/docs/Web/HTML/Element/iframe#sandbox
 * @see https://html.spec.whatwg.org/multipage/iframe-embed-object.html#attr-iframe-sandbox
 */

// ---------------------------------------------------------------------------
// Link scheme allowlist
// ---------------------------------------------------------------------------

/**
 * Link schemes a sandboxed frame may ask the host to open on its behalf.
 *
 * One definition for both sides of the relay: the in-frame interceptor
 * interpolates it to decide what to hand over (routing) and
 * {@link isRelayableExternalHref} applies it to what arrives (the security
 * check). Two copies would drift into links the frame relays and the host
 * refuses, or the reverse.
 */
const RELAYABLE_LINK_SCHEME_RE = /^(https?|mailto|tel):/i;

/**
 * Whether a sandboxed frame's link may be opened by the host.
 *
 * The host is the authority on this: a frame that relays `vellum_open_link`
 * controls the `href` string entirely, so the in-frame scheme check is a
 * routing decision and this one is the security check. Anything outside the
 * allowlist (`javascript:`, `data:`, `blob:`, `file:`, custom schemes) is
 * refused.
 */
export function isRelayableExternalHref(href: unknown): href is string {
  return typeof href === "string" && RELAYABLE_LINK_SCHEME_RE.test(href.trim());
}

// ---------------------------------------------------------------------------
// Script serialization
// ---------------------------------------------------------------------------

/**
 * Safely serialize a value for embedding inside an inline `<script>` block.
 *
 * `JSON.stringify` alone doesn't escape `</script>` or `<!--`, which can
 * break out of the script context in `srcdoc`. We replace the two dangerous
 * sequences after stringifying.
 *
 * @see https://html.spec.whatwg.org/multipage/scripting.html#restrictions-for-contents-of-script-elements
 */
export function jsonForScript(value: unknown): string {
  return JSON.stringify(value)
    .replace(/<\//g, "<\\/")
    .replace(/<!--/g, "<\\!--");
}

// ---------------------------------------------------------------------------
// Storage polyfill
// ---------------------------------------------------------------------------

/**
 * Build a `<script>` tag that replaces `localStorage` and `sessionStorage`
 * with in-memory shims.
 *
 * Required for every sandboxed iframe without `allow-same-origin`. Without
 * this, any code that accesses `window.localStorage` — including framework
 * initialization in React, Vue, i18next, etc. — throws a `SecurityError`
 * and prevents the app from mounting.
 */
export function buildStoragePolyfill(): string {
  return `<script>
(function() {
  var store = {};
  var storageShim = {
    getItem: function(k) { return store.hasOwnProperty(k) ? store[k] : null; },
    setItem: function(k, v) { store[k] = String(v); },
    removeItem: function(k) { delete store[k]; },
    clear: function() { store = {}; },
    get length() { return Object.keys(store).length; },
    key: function(i) { return Object.keys(store)[i] || null; }
  };
  try {
    Object.defineProperty(window, 'localStorage', { get: function() { return storageShim; }, configurable: true });
  } catch(e) {}
  try {
    Object.defineProperty(window, 'sessionStorage', { get: function() { return storageShim; }, configurable: true });
  } catch(e) {}
})();
</script>`;
}

// ---------------------------------------------------------------------------
// Link interceptor
// ---------------------------------------------------------------------------

/**
 * Build a `<script>` tag that intercepts clicks on `<a>` elements inside the
 * sandboxed iframe and either opens them in new tabs or relays them to the
 * parent.
 *
 * Sandboxed iframes without `allow-top-navigation` cannot navigate the parent
 * window, so plain `<a href="...">` links are silently non-interactive. Rather
 * than granting `allow-top-navigation` (which would let untrusted markup
 * redirect the host page at will), this interceptor uses event delegation to
 * catch link clicks.
 *
 * The listener is registered in the **bubble** phase (not capture) and bails
 * out early if `e.defaultPrevented` is already true, so sandboxed click
 * handlers run first and can handle a link themselves.
 *
 * Scheme detection uses the **raw** `href` attribute, not the resolved
 * `el.href` property: in `srcdoc` documents the browser resolves relative and
 * fragment links against the embedding page's URL, so `el.href` can become an
 * absolute `http(s)` URL that would be wrongly intercepted.
 *
 * @param frameId The iframe identifier, included in relayed messages so the
 *   parent knows which surface sent the request.
 * @param options.relayExternal Relay external links to the parent as
 *   `vellum_open_link` instead of calling `window.open()`. Required for frames
 *   sandboxed without `allow-popups`, where `window.open()` is a silent no-op.
 * @param options.relayAppRoutes Relay root-relative `/assistant/...` routes to
 *   the parent as `vellum_navigate` instead of loading them in the iframe.
 */
export function buildLinkInterceptorScript(
  frameId: string,
  options?: { relayExternal?: boolean; relayAppRoutes?: boolean },
): string {
  const externalHandler = options?.relayExternal
    ? `window.parent.postMessage({
              type: 'vellum_open_link',
              frameId: ${jsonForScript(frameId)},
              href: rawHref,
              linkText: (el.textContent || '').trim()
            }, '*');`
    : `window.open(rawHref, '_blank', 'noopener,noreferrer');`;
  const appRouteHandler = options?.relayAppRoutes
    ? `if (rawHref === '/assistant' || rawHref.indexOf('/assistant/') === 0 || rawHref.indexOf('/assistant?') === 0 || rawHref.indexOf('/assistant#') === 0) {
            e.preventDefault();
            window.parent.postMessage({
              type: 'vellum_navigate',
              frameId: ${jsonForScript(frameId)},
              href: rawHref
            }, '*');
            return;
          }`
    : "";

  return `<script>
(function() {
    document.addEventListener('click', function(e) {
      // Bubble phase: let app handlers run first. If they already handled
      // the click (preventDefault), defer to them.
      if (e.defaultPrevented) return;
      var el = e.target;
      while (el && el !== document.body) {
        // Compared case-insensitively: \`tagName\` is upper-cased for HTML
        // elements but preserves case for SVG, where an anchor reports 'a'.
        // Visuals are frequently SVG diagrams, so an exact 'A' test leaves
        // every link drawn inside the artwork dead.
        if (el.tagName && String(el.tagName).toUpperCase() === 'A' && el.getAttribute('href')) {
          // Use the raw href attribute for scheme detection. In srcdoc
          // documents el.href resolves fragment/relative links against the
          // embedding page URL, producing absolute http(s) URLs that would
          // be wrongly intercepted. The raw attribute preserves the scheme.
          var rawHref = el.getAttribute('href');
          ${appRouteHandler}
          // vellum:// deep links — forward to the parent for in-app
          // navigation. Checked before external schemes because
          // window.open() cannot handle custom schemes (a vellum:// URL
          // would be silently dropped or open a broken tab).
          if (/^vellum:\\/\\/(workspace|host)\\//i.test(rawHref)) {
            e.preventDefault();
            window.parent.postMessage({
              type: 'vellum_open_link',
              frameId: ${jsonForScript(frameId)},
              href: rawHref,
              linkText: (el.textContent || '').trim()
            }, '*');
            return;
          }
          if (${RELAYABLE_LINK_SCHEME_RE.toString()}.test(rawHref)) {
            e.preventDefault();
            ${externalHandler}
            return;
          }
        }
        el = el.parentElement;
      }
    }, false);
})();
</script>`;
}

// ---------------------------------------------------------------------------
// Widget bridge (inline visual surfaces)
// ---------------------------------------------------------------------------

/**
 * Build a `<script>` tag that reports the widget's content height to the
 * parent so an inline visual sizes itself instead of guessing.
 *
 * The measurement anchors on `document.body` rather than
 * `document.documentElement`: the root element's `scrollHeight` is floored at
 * the viewport, so a widget whose content shrinks could never report a
 * smaller height. With the widget base styles zeroing body margin, the body's
 * scroll height *is* the content height in both directions.
 *
 * Updates are coalesced through `requestAnimationFrame` and suppressed below a
 * one-pixel delta, so a `ResizeObserver` firing on every layout pass — including
 * the pass caused by the parent applying the previous report — settles instead
 * of oscillating.
 *
 * The shrink-to-fit pass (see {@link buildWidgetWidthFitScript}) publishes the
 * zoom it applied as `window.__vellumWidgetZoom`. Engines disagree on whether the
 * box-metric properties of a zoomed element report layout or visual pixels, so
 * the scaled metrics are compared against the bounding rect, which is always
 * visual: whichever reading is the zoom-adjusted one wins the `Math.max` and
 * the reported height is the space the frame actually needs.
 *
 * @param frameId The iframe identifier, echoed back so the parent can reject
 *   messages from any other frame.
 */
export function buildWidgetHeightReporterScript(frameId: string): string {
  return `<script>
(function() {
  var lastHeight = 0;
  var scheduled = false;
  function measure() {
    var body = document.body;
    if (!body) return;
    var zoom = window.__vellumWidgetZoom || 1;
    var height = Math.max(
      Math.ceil(body.scrollHeight * zoom),
      Math.ceil(body.offsetHeight * zoom),
      Math.ceil(body.getBoundingClientRect().height)
    );
    if (!height || Math.abs(height - lastHeight) < 2) return;
    lastHeight = height;
    window.parent.postMessage({
      type: 'vellum_widget_height',
      frameId: ${jsonForScript(frameId)},
      height: height
    }, '*');
  }
  function schedule() {
    if (scheduled) return;
    scheduled = true;
    var run = function() { scheduled = false; measure(); };
    if (typeof requestAnimationFrame === 'function') { requestAnimationFrame(run); } else { setTimeout(run, 16); }
  }
  if (typeof ResizeObserver === 'function' && document.body) {
    new ResizeObserver(schedule).observe(document.body);
  }
  window.addEventListener('load', schedule);
  window.addEventListener('resize', schedule);
  schedule();
})();
</script>`;
}

/**
 * Smallest shrink-to-fit scale. Below this the safety net stops and lets the
 * content clip: a diagram scaled past a third off is unreadable, which is a
 * worse outcome than a clipped edge the user can still see is clipped.
 */
const WIDGET_MIN_FIT_SCALE = 0.7;

/** Overflow under this many pixels is rounding, not a layout that spills. */
const WIDGET_FIT_TOLERANCE_PX = 2;

/**
 * Build a `<script>` tag that scales a too-wide widget down until it fits.
 *
 * A fragment authored past the frame's width is clipped with no scrollbar and
 * no other signal, so content simply disappears at the right edge. This is the
 * safety net for that: when the body's scroll width overruns the viewport, the
 * body is zoomed by the ratio that closes the gap.
 *
 * `zoom` rather than `transform: scale()` because zoom reflows: the body's box
 * shrinks with its content, so the height reporter measures the scaled result
 * instead of the pre-scale layout with a band of empty space under it. The
 * applied factor is published on `window.__vellumWidgetZoom` for the reporter to
 * read (see {@link buildWidgetHeightReporterScript}).
 *
 * Measurement resets any previous zoom first, so the natural width is read at
 * 1 every time and repeated passes converge rather than compounding. It runs
 * after first layout, after `load`, once fonts settle (a fallback face is
 * usually wider than the real one), and on resize.
 */
export function buildWidgetWidthFitScript(): string {
  return `<script>
(function() {
  var MIN_SCALE = ${WIDGET_MIN_FIT_SCALE};
  var TOLERANCE = ${WIDGET_FIT_TOLERANCE_PX};
  var scheduled = false;
  window.__vellumWidgetZoom = 1;
  function fit() {
    var body = document.body;
    if (!body) return;
    if (window.__vellumWidgetZoom !== 1) {
      body.style.zoom = '';
      window.__vellumWidgetZoom = 1;
    }
    var available = document.documentElement.clientWidth;
    var natural = body.scrollWidth;
    if (!available || !natural) return;
    if (natural - available <= TOLERANCE) return;
    var scale = available / natural;
    if (scale < MIN_SCALE) return;
    window.__vellumWidgetZoom = scale;
    body.style.zoom = String(scale);
  }
  function schedule() {
    if (scheduled) return;
    scheduled = true;
    var run = function() { scheduled = false; fit(); };
    if (typeof requestAnimationFrame === 'function') { requestAnimationFrame(run); } else { setTimeout(run, 16); }
  }
  window.addEventListener('load', schedule);
  window.addEventListener('resize', schedule);
  if (document.fonts && document.fonts.ready && typeof document.fonts.ready.then === 'function') {
    document.fonts.ready.then(schedule);
  }
  schedule();
})();
</script>`;
}

/**
 * Build a `<script>` tag exposing the widget's `sendPrompt(text)` global and
 * the Amiro `window.applet` bridge.
 *
 * A widget calls `sendPrompt` to hand a follow-up question back to the
 * assistant — the parent turns the message into a real user turn. The parent
 * requires an active user activation, so a widget cannot relay prompts on load
 * or in a loop; sending from anywhere but a click handler is silently dropped.
 *
 * `window.applet.sendPrompt` is the same relay, so a fragment written against
 * Amiro's applet view model works unchanged. `window.applet.action(name, args)`
 * forwards a named action to the host.
 *
 * @param frameId The iframe identifier, echoed back so the parent can reject
 *   messages from any other frame.
 */
export function buildWidgetPromptScript(frameId: string): string {
  return `<script>
(function() {
  window.sendPrompt = function(text) {
    if (text == null) return;
    var prompt = String(text).trim();
    if (!prompt) return;
    window.parent.postMessage({
      type: 'vellum_widget_prompt',
      frameId: ${jsonForScript(frameId)},
      prompt: prompt
    }, '*');
  };
  window.applet = {
    sendPrompt: window.sendPrompt,
    action: function(action, args) {
      if (action == null) return;
      var name = String(action).trim();
      if (!name) return;
      window.parent.postMessage({
        type: 'applet_action',
        frameId: ${jsonForScript(frameId)},
        action: name,
        args: args == null ? {} : args
      }, '*');
    }
  };
})();
</script>`;
}

/**
 * Content-Security-Policy for inline visual documents. A sandboxed frame
 * without `allow-same-origin` still permits outbound subresource loads
 * (`<img src="https://…">`, CSS `url(…)`, script-created `fetch`/`Image`),
 * which would let model-authored markup leak conversation-derived content to
 * arbitrary hosts. A visual is self-contained by contract: everything inline,
 * fonts and images only as `data:` URIs, no network at all.
 *
 * `base-uri` and `form-action` are listed explicitly because neither falls back
 * to `default-src`: without them a `<base href>` retargets every relative URL
 * in the document and a form posts wherever it likes.
 */
export const WIDGET_CSP_META =
  `<meta http-equiv="Content-Security-Policy" content="` +
  `default-src 'none'; script-src 'unsafe-inline'; ` +
  `style-src 'unsafe-inline'; img-src data:; font-src data:; ` +
  `base-uri 'none'; form-action 'none'; frame-src 'none'">`;

/**
 * Inject the widget bridge into an inline visual's HTML.
 *
 * Unlike a full app bridge there is no fetch proxy and no `window.vellum`
 * namespace — a visual is a self-contained illustration, not an app. It gets
 * a network-blocking CSP (first, so it governs every script and subresource
 * that follows), the storage polyfill, the shared link interceptor, the
 * shrink-to-fit pass, the height reporter and `sendPrompt`.
 *
 * The link interceptor relays external links rather than opening them: the
 * visual frame is sandboxed without `allow-popups`, so an in-frame
 * `window.open()` does nothing and the host opens the link instead.
 *
 * @param head Markup prepended alongside the storage polyfill — the resolved
 *   design tokens and inlined brand fonts.
 */
export function injectWidgetBridge(
  html: string,
  frameId: string,
  head = "",
): string {
  return prependScript(
    injectScript(
      prependDocumentStart(html, WIDGET_CSP_META),
      buildWidgetWidthFitScript() +
        buildWidgetHeightReporterScript(frameId) +
        buildWidgetPromptScript(frameId) +
        buildLinkInterceptorScript(frameId, { relayExternal: true }),
      // A visual is often a bare fragment (`<svg>…`, `<div>…`); the height
      // reporter has to sit after it so `document.body` is populated when the
      // first measurement runs.
      { fallback: "append" },
    ),
    buildStoragePolyfill() + head,
  );
}

// ---------------------------------------------------------------------------
// HTML injection
// ---------------------------------------------------------------------------

export interface InjectScriptOptions {
  /**
   * Where the script goes when the HTML is a bare fragment with no `</body>`
   * or `</head>`. `"prepend"` (the default) puts it ahead of the fragment so
   * app code can rely on the bridge during parsing; `"append"` puts it after,
   * which is what a widget wants — its scripts observe content that must
   * already exist.
   */
  fallback?: "prepend" | "append";
}

/**
 * Safely inject a script string into HTML at the end of the document.
 *
 * Insertion priority: before the last `</body>`, then after the last
 * `</head>`, then per `options.fallback`. Uses `lastIndexOf` so that literal
 * close-tag sequences inside `<script>` blocks (comments, strings) can't
 * hijack the injection site.
 */
export function injectScript(
  html: string,
  script: string,
  options?: InjectScriptOptions,
): string {
  const BODY_CLOSE = "</body>";
  const HEAD_CLOSE = "</head>";

  const bodyIdx = html.lastIndexOf(BODY_CLOSE);
  if (bodyIdx !== -1) {
    return html.slice(0, bodyIdx) + script + html.slice(bodyIdx);
  }
  const headIdx = html.lastIndexOf(HEAD_CLOSE);
  if (headIdx !== -1) {
    const after = headIdx + HEAD_CLOSE.length;
    return html.slice(0, after) + script + html.slice(after);
  }
  return options?.fallback === "append" ? html + script : script + html;
}

const HEAD_OPEN_RE = /<head(\s[^>]*)?>/i;
const HTML_OPEN_RE = /<html(\s[^>]*)?>/i;

/**
 * Prepend a script to the beginning of an HTML document so it executes
 * before any other scripts during HTML parsing.
 *
 * Insertion priority: right after `<head>`, then after `<html>`, then
 * prepended to the raw string. This ensures the script runs before any
 * inline `<script>` tags in the body.
 */
export function prependScript(html: string, script: string): string {
  const headMatch = HEAD_OPEN_RE.exec(html);
  if (headMatch) {
    const after = headMatch.index + headMatch[0].length;
    return html.slice(0, after) + script + html.slice(after);
  }
  const htmlMatch = HTML_OPEN_RE.exec(html);
  if (htmlMatch) {
    const after = htmlMatch.index + htmlMatch[0].length;
    return html.slice(0, after) + script + html.slice(after);
  }
  return script + html;
}

const DOCTYPE_RE = /<!doctype\s+[^>]*>/i;

/**
 * Prepend markup at the very start of the document, after any doctype.
 *
 * A `<meta>` CSP only governs tokens that follow it in the document, so it
 * must precede every app-controlled token. Inserting after `<head>` is not
 * enough: in a malformed document a `<script>` serialized before the
 * `<head>` tag is relocated into the implicit head in source order and
 * executes before a policy placed after the head open tag exists.
 */
export function prependDocumentStart(html: string, markup: string): string {
  const doctypeMatch = DOCTYPE_RE.exec(html);
  if (doctypeMatch) {
    const after = doctypeMatch.index + doctypeMatch[0].length;
    return html.slice(0, after) + markup + html.slice(after);
  }
  return markup + html;
}

/**
 * Prepare HTML for a non-interactive preview iframe.
 *
 * Prepends the storage polyfill so it executes before any inline app
 * scripts that might access `localStorage` during parsing. Also hides
 * scrollbars for the thumbnail viewport.
 */
export function preparePreviewHtml(html: string): string {
  const HIDE_SCROLLBARS =
    "<style>html,body{overflow:hidden!important;scrollbar-width:none!important;}::-webkit-scrollbar{display:none!important;}</style>";
  return prependScript(html, buildStoragePolyfill() + HIDE_SCROLLBARS);
}

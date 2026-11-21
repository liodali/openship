/**
 * The page the edge serves for a hostname it RETAINS while its backend is gone —
 * the third page of the set, built the same way as {@link ./edge-not-found.ts} and
 * {@link ./edge-upstream-down.ts} (whose headers carry the reasoning this file
 * repeats only where a detail differs).
 *
 * Where upstream-down covers "routed, and NOT answering" (nginx fails to reach the
 * upstream or times out — 502/504), this covers the state the discovery reconciler
 * deliberately puts a vhost in when a discovered container stops or is removed:
 * the backend is KNOWN withdrawn, so the vhost stops proxying entirely and answers
 * 503 on every path (`UnavailableRouteConfig`). Before this page, that answer was
 * a bare `return 503;` — OpenResty's stock error body, the exact failure the
 * upstream-down page fixed for the 502 case: a page that carries whoever built the
 * edge binary, and nothing that tells a visitor what happened or what to expect.
 *
 * The message is the one the retained-vhost contract implies: the application was
 * here, it is not now, and this is temporary. Deliberately NOT on the page: any
 * link, the service or container name, its ports, the project, the operator's
 * dashboard URL, `$host`, and any reflected detail of the route — this is served
 * to strangers, and the route's upstream URL (an IP + port) would be exactly the
 * internal fact a stranger must not learn. The page is a CONSTANT, so nothing
 * route-specific can reach it by construction; the tests keep it that way.
 *
 * Deliberately UNBRANDED as well: no product name, logo, footer or dashboard URL
 * in the visible page. It answers on the OPERATOR's own domain, for the operator's
 * own visitors — a vendor signature there advertises a third party on someone
 * else's site (the same reason the upstream-down page exists at all). The design
 * is a compact neutral status card: one soft generic icon, one heading, one line
 * of guidance, light and dark. The sentinel comment below stays the page's ONLY
 * product identifier — invisible to visitors, present for `curl | head -c 200`.
 *
 * Why the body is INLINE in the config, and the tokenizer constraints (no `'`, no
 * `$`, no newline, no `#`, balanced braces): inherited unchanged from the two
 * siblings, each violation produces a config that fails `openresty -t`, and a
 * failed test means the reload is refused — no route change lands on the box
 * until someone finds it, and on a fresh container it is a crash loop.
 *
 * Why there is NO `error_page` + named location here, unlike the upstream-down
 * handler: that one intercepts an error the proxy hop produced, and a named
 * location is how nginx lets a body claim the ORIGINAL status. Here nothing is
 * intercepted — the serving location itself generates the response (`return 503`
 * with a body, the same directive the bare form used), so there is no redirect
 * hop to skip and no other code in this vhost that 503 could mask. The ACME and
 * edge-challenge locations are emitted separately and stay live, which is the
 * whole point of retaining the vhost.
 *
 * Cache-Control is NOT here on purpose: `add_header` may never be emitted inside
 * a location (the inheritance invariant on `renderServerHeaders` — a location
 * that declares one drops every inherited header), so the `no-store` lives at
 * server scope in `nginx.ts` next to the route's other response headers. What
 * this body carries is only what MUST be location-scoped: `types { }` +
 * `default_type text/html`, because `return` with a body picks the content type
 * from the request URI's extension — without the cleared map, a request for the
 * stopped app's `/app.css` would be answered `Content-Type: text/css` with an
 * HTML body.
 */

/**
 * Machine-readable marker that THIS page — our edge, for a retained hostname whose
 * backend was withdrawn — is what answered. Sits immediately after the doctype so
 * `curl -s https://host | head -c 200` shows it, and distinct from the unrouted
 * page's sentinel (`openship-edge-unrouted`) and the upstream-down one
 * (`openship-edge-upstream-down`) so the three cases are told apart at a glance:
 * "nothing is deployed at this name" / "deployed and not answering" / "deployed,
 * stopped on purpose, retained".
 *
 * A support/diagnostic marker, and ONLY that. Nothing branches on it.
 */
export const EDGE_UNAVAILABLE_SENTINEL = "openship-edge-unavailable";

/**
 * The page, in fragments. Joined with no separator, so every fragment must be
 * self-contained at its boundaries (a break only ever falls between tags or between CSS
 * declarations — never inside a text node, where the missing newline would run two words
 * together).
 */
const HTML_FRAGMENTS: readonly string[] = [
  `<!doctype html>`,
  `<!--${EDGE_UNAVAILABLE_SENTINEL}-->`,
  `<html lang="en">`,
  `<head>`,
  `<meta charset="utf-8">`,
  `<meta name="viewport" content="width=device-width,initial-scale=1">`,
  // A temporarily-unavailable page must never be the version of the host that
  // enters a search index — same reason as the upstream-down page.
  `<meta name="robots" content="noindex,nofollow">`,
  `<title>Application temporarily unavailable</title>`,
  `<style>`,
  // Neutral light scale mirrored for dark — an unbranded status card, not a
  // product page. No webfont, no image, no external request: the page must render
  // on a box whose only working listener is the one serving it. Colours are
  // `rgb()`/`rgba()`, never a hex triplet — see the no-`#` invariant above.
  `:root{color-scheme:light dark}`,
  `*{box-sizing:border-box}`,
  `body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;background:rgb(255,255,255);color:rgba(0,0,0,.66);font:15px/1.6 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif;-webkit-font-smoothing:antialiased}`,
  `main{width:100%;max-width:26rem;padding:2.5rem 1.5rem;text-align:center}`,
  // .66 on white ≈ 7:1, and the dark mirror clears AA on rgb(10,10,10) by a wide
  // margin — the supporting line stays readable in both appearances.
  `.art{display:block;width:64px;height:64px;margin:0 auto 1.75rem}`,
  `.art-bg{fill:rgba(0,0,0,.05)}`,
  `.art-line{fill:none;stroke:rgba(0,0,0,.45);stroke-width:2.5;stroke-linecap:round;stroke-linejoin:round}`,
  `h1{margin:0 0 .75rem;font-size:1.25rem;font-weight:600;letter-spacing:-.01em;color:rgba(0,0,0,.92)}`,
  `p{margin:0}`,
  `@media(prefers-color-scheme:dark){`,
  `body{background:rgb(10,10,10);color:rgba(255,255,255,.66)}`,
  `.art-bg{fill:rgba(255,255,255,.08)}`,
  `.art-line{stroke:rgba(255,255,255,.5)}`,
  `h1{color:rgba(255,255,255,.95)}`,
  `}`,
  `</style>`,
  `</head>`,
  `<body>`,
  `<main>`,
  // A generic clock in a soft disc — "back in a moment" without a status number,
  // a brand, or any claim about the backend's internals. Inline SVG only; the
  // class-driven fills/strokes follow the appearance above.
  `<svg class="art" viewBox="0 0 64 64" aria-hidden="true"><circle class="art-bg" cx="32" cy="32" r="30"/><circle class="art-line" cx="32" cy="32" r="13"/><path class="art-line" d="M32 25v7l5 3"/></svg>`,
  `<h1>Application temporarily unavailable</h1>`,
  // The whole message: one heading, one line of guidance. No bullet list, no
  // container-state claims, no promise about WHEN the app returns — resumption is
  // the reconciler's job on the backend's own lifecycle, not the page's.
  `<p>Please try again in a moment.</p>`,
  `</main>`,
  `</body>`,
  `</html>`,
];

/** The page as one line, ready to be embedded in a single-quoted nginx token. */
export const EDGE_UNAVAILABLE_HTML = HTML_FRAGMENTS.join("");

/**
 * The body of `location /` for a retained unavailable vhost, replacing the bare
 * `return 503;` this shape used to emit.
 *
 * The FIRST line carries no leading indent on purpose: it is interpolated into
 * `location / {` after the template's own eight-space margin (and, on :80, after
 * {@link ./nginx.ts} `HTTPS_UPGRADE`'s trailing one), the same way the static
 * route's `root …` body is — every following line carries its own eight spaces.
 *
 * `return 503 '<body>'` — the `return` sets the status itself, so the response
 * line reads exactly `503`. Nothing else in this vhost can 503: the only other
 * locations are the two challenge handlers, which are `^~`-matched ahead of
 * `location /` and stay live.
 */
export const EDGE_UNAVAILABLE_BODY = `types { }
        default_type text/html;
        return 503 '${EDGE_UNAVAILABLE_HTML}';`;

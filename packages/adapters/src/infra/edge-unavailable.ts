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
  // Same neutral black-on-white scale as the 404 and upstream-down pages, mirrored
  // for dark, so the three pages the edge serves read as one system. No webfont, no
  // image, no external request: the page must render on a box whose only working
  // listener is the one serving it. Colours are `rgb()`, never a hex triplet — see
  // the no-`#` invariant above.
  `:root{color-scheme:light dark}`,
  `*{box-sizing:border-box}`,
  `body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;background:rgb(255,255,255);color:rgba(0,0,0,.66);font:15px/1.6 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif;-webkit-font-smoothing:antialiased}`,
  `main{width:100%;max-width:32rem;padding:2.5rem 1.5rem;text-align:center}`,
  // .56 on white ≈ 4.75:1 — WCAG AA for text this small, the scale the 404 page
  // settled on after its lighter first draft measured under the bar.
  `.tag{display:inline-flex;align-items:center;gap:.5rem;margin-bottom:1.25rem;padding:.25rem .625rem;border:1px solid rgba(0,0,0,.1);border-radius:999px;font-size:12px;color:rgba(0,0,0,.56)}`,
  // Red, like upstream-down rather than the 404 page's amber: this host WAS wired
  // up and answered before, which is closer to "an app that should be serving and
  // is not" than to "nothing was ever deployed here".
  `.dot{width:6px;height:6px;border-radius:50%;background:rgb(214,69,58)}`,
  `h1{margin:0 0 .5rem;font-size:1.375rem;font-weight:600;letter-spacing:-.01em;color:rgba(0,0,0,.92)}`,
  `p{margin:0 auto 1.5rem;max-width:26rem}`,
  `ul{display:inline-block;margin:0;padding:0;list-style:none;text-align:left;font-size:13.5px;color:rgba(0,0,0,.56)}`,
  `li{position:relative;padding:.2rem 0 .2rem 1rem}`,
  `li::before{content:"";position:absolute;left:0;top:.75em;width:4px;height:4px;border-radius:50%;background:rgba(0,0,0,.25)}`,
  `footer{margin-top:2.25rem;font-size:12px;color:rgba(0,0,0,.56)}`,
  `@media(prefers-color-scheme:dark){`,
  `body{background:rgb(10,10,10);color:rgba(255,255,255,.66)}`,
  `.tag{border-color:rgba(255,255,255,.12);color:rgba(255,255,255,.56)}`,
  `h1{color:rgba(255,255,255,.95)}`,
  `ul{color:rgba(255,255,255,.56)}`,
  `li::before{background:rgba(255,255,255,.28)}`,
  `footer{color:rgba(255,255,255,.56)}`,
  `}`,
  `</style>`,
  `</head>`,
  `<body>`,
  `<main>`,
  // No status number in the tag: the status line carries the real code (503), and
  // the page exists for people, not for parsers.
  `<span class="tag"><span class="dot"></span>temporarily unavailable</span>`,
  `<h1>Application temporarily unavailable</h1>`,
  // The whole message, in one sentence: it happened, it is known, it is not
  // permanent. The distinction from the upstream-down page is subtext, not copy:
  // there the app may be crashing or merely slow; here the edge KNOWS the backend
  // was withdrawn, so the page promises nothing is wrong with the visitor's
  // request — only that the application is not running.
  `<p>This application is temporarily unavailable. Please try again later.</p>`,
  `<ul>`,
  `<li>The application behind this address has stopped</li>`,
  `<li>It will become available again when the application starts</li>`,
  `</ul>`,
  `<footer>Served by Openship</footer>`,
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

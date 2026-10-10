/**
 * The helpers every Market operation's function starts with, as source:
 * sleeping between requests, the answers of a failed step, the page's
 * `sk`, and a page of the service read without its redirects to the
 * sign-in or the captcha going unnoticed.
 */
const marketPrologue = String.raw`const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ok = (data) => ({ ok: true, data });
const fail = (code, message) => ({ ok: false, error: { code, message } });
const getSk = async () => {
  const s = window.state && window.state.user && window.state.user.sk;
  if (s) return s;
  const h = await (
    await fetch("/my/wishlist", { credentials: "include" })
  ).text();
  const m = h.match(/"sk":"(u[0-9a-f]{20,})"/);
  return m && m[1];
};
const getPage = async (path) => {
  const r = await fetch(path, { credentials: "include" });
  if (/passport\.yandex\./.test(r.url))
    return {
      error: fail("not_signed_in", "redirected to " + new URL(r.url).host),
    };
  if (/showcaptcha|\/captcha/.test(r.url) || r.status === 429)
    return { error: fail("captcha", "captcha at " + new URL(r.url).pathname) };
  if (!r.ok) return { error: fail("http_" + r.status, path) };
  const html = await r.text();
  if (!/"user":\{"sk":"[^"]+","uid":"\d+"/.test(html))
    return { error: fail("not_signed_in", "no uid in page state") };
  return { html, doc: new DOMParser().parseFromString(html, "text/html") };
};`;

/**
 * The source of one operation's `run`: the prologue, then the operation's
 * body, which answers `ok(data)` or `fail(code, message)`. The wrapper turns
 * the answer into `operationAnswerSchema`: a sign-in or a captcha is its own
 * answer, any other failure throws, so the transport reports a failed call
 * with no text of the page.
 */
export function marketRun(body: string) {
  return `async function (args) {
${marketPrologue}
const result = await (async () => {
${body}
})();
if (result.ok) return { status: "ok", data: result.data };
if (result.error.code === "not_signed_in") return { status: "signed_out" };
if (result.error.code === "captcha") return { status: "captcha" };
throw new Error(result.error.code);
}`;
}

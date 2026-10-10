/**
 * The page's own session for Yandex Maps, as JavaScript source for the
 * operations' `run` functions: `csrfToken` and `sessionId` from the page's
 * JSON context (or from its HTML), and `mapsCall(path, params)`, a GET to
 * `/maps/api/*` with the request signed by `s`. A stale token comes back as
 * a new one without `data`; the call is then made once more with it.
 */
export const mapsPage = `
const mapsSign = (text) => {
  let h = 5381;
  for (const b of new TextEncoder().encode(text)) h = (((h << 5) + h) ^ b) >>> 0;
  return h;
};
const mapsContext = async () => {
  const found = [...document.scripts]
    .map((s) => (s.type === "application/json" ? s.textContent : ""))
    .find((t) => t.includes('"csrfToken"'));
  const text = found || (await (await fetch("/maps/")).text());
  const csrf = text.match(/"csrfToken":"([^"]+)"/);
  const session = text.match(/"sessionId":"([^"]+)"/);
  if (!csrf || !session) return null;
  return { csrfToken: csrf[1], sessionId: session[1] };
};
const mapsCall = async (session, path, params) => {
  const attempt = async () => {
    const p = [
      ["ajax", "1"],
      ["csrfToken", session.csrfToken],
      ["sessionId", session.sessionId],
      ...params,
    ].sort((a, b) => (a[0] < b[0] ? -1 : 1));
    const qs = p.map(([k, v]) => encodeURIComponent(k) + "=" + encodeURIComponent(v)).join("&");
    return fetch(path + "?" + qs + "&s=" + mapsSign(qs));
  };
  let r = await attempt();
  if (r.status === 401) return { wall: "signed_out" };
  if (r.status !== 200) return { error: "http_" + r.status };
  let j = await r.json();
  if (j.data === undefined && j.csrfToken) {
    session.csrfToken = j.csrfToken;
    r = await attempt();
    if (r.status !== 200) return { error: "http_" + r.status };
    j = await r.json();
  }
  if (j.error) return { error: "api_" + j.error.code };
  return j.data === undefined ? { error: "no_data" } : j.data;
};
const mapsAnswer = (x) =>
  x.wall ? { status: "signed_out" } : x.error ? { status: "ok", data: { error: x.error } } : null;
`;

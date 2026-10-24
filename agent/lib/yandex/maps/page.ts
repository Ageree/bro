/**
 * The session for Yandex Maps' API, as JavaScript source for the operations'
 * `run` functions: `csrfToken` and `sessionId` from the page's JSON context
 * when the page has one, otherwise an empty token and a session id of its
 * own; and `mapsCall(path, params)`, a GET to `/maps/api/*` with the request
 * signed by `s`. A stale or empty token comes back as a new one without
 * `data`; the call is then made once more with it. The API takes a session
 * of the call's own: the operations run on a light page of yandex.ru and do
 * not load `/maps/` (8.9 MB, and for the pool browser often a captcha page).
 */
export const mapsPage = `
const mapsSign = (text) => {
  let h = 5381;
  for (const b of new TextEncoder().encode(text)) h = (((h << 5) + h) ^ b) >>> 0;
  return h;
};
const mapsContext = () => {
  const found = [...document.scripts]
    .map((s) => (s.type === "application/json" ? s.textContent : ""))
    .find((t) => t.includes('"csrfToken"'));
  const csrf = found && found.match(/"csrfToken":"([^"]+)"/);
  const session = found && found.match(/"sessionId":"([^"]+)"/);
  if (csrf && session) return { csrfToken: csrf[1], sessionId: session[1] };
  return { csrfToken: "", sessionId: Date.now() + "_" + Math.floor(Math.random() * 1e6) };
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
// A place booked through YClients names its YClients company:
// \`booking.originalId\` is "yclients__664163" (24.10, the yclients tool).
const mapsYclients = (booking) => {
  const id = booking && /^yclients__([1-9]\\d{0,11})$/.exec(booking.originalId || "");
  return id ? Number(id[1]) : null;
};
const mapsAnswer = (x) =>
  x.wall ? { status: "signed_out" } : x.error ? { status: "ok", data: { error: x.error } } : null;
`;

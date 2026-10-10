/**
 * The page's own session for Yandex Go's API, as JavaScript source for the
 * operations' `run` functions: the user id the page keeps in IndexedDB, and
 * a CSRF token from `POST /csrf_token`. `goSession()` answers the session
 * with `post(path, body)`, or with `wall` (signed out) or `error` (a fault
 * named in words, never the page's text).
 */
export const goSession = `
const goSession = async () => {
  const db = await new Promise((res, rej) => {
    const q = indexedDB.open("turboapp-taxi");
    q.onsuccess = () => res(q.result);
    q.onerror = () => rej(q.error);
  });
  const stored = await new Promise((r) => {
    const q = db
      .transaction("redux-persist", "readonly")
      .objectStore("redux-persist")
      .get("persist:session");
    q.onsuccess = () => r(q.result);
  });
  const raw = typeof stored === "string" ? JSON.parse(stored) : stored;
  const userId = raw && raw.userId;
  if (!/^[0-9a-f]{32}$/.test(userId || "")) return { error: "no_user_id" };
  const origin = "https://ya-authproxy.taxi.yandex.ru";
  const base = {
    "content-type": "application/json",
    "x-requested-with": "XMLHttpRequest",
    "x-yataxi-userid": userId,
    "x-taxi": navigator.userAgent + " turboapp_taxi",
    "accept-language": "ru",
    "x-yataxi-tz-offset": "10800",
  };
  const csrf = await fetch(origin + "/csrf_token", {
    method: "POST",
    headers: base,
    credentials: "include",
    body: "{}",
  });
  if (csrf.status === 401) return { wall: "signed_out" };
  if (csrf.status !== 200) return { error: "csrf_" + csrf.status };
  const headers = { ...base, "x-csrf-token": (await csrf.json()).sk };
  const post = async (path, body) => {
    const r = await fetch(origin + path, {
      method: "POST",
      headers,
      credentials: "include",
      body: JSON.stringify(body),
    });
    if (r.status === 401) return { wall: "signed_out" };
    if (r.status !== 200) return { error: "http_" + r.status };
    return r.json();
  };
  return { post, userId };
};
const goAnswer = (x) =>
  x.wall ? { status: "signed_out" } : x.error ? { status: "ok", data: { error: x.error } } : null;
`;

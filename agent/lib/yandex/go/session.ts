export const goApiPage = "https://taxi.yandex.ru/robots.txt";

/**
 * The page's own session for Yandex Go's API, as JavaScript source for the
 * operations' `run` functions: the user id the page keeps in IndexedDB, and
 * a CSRF token from `POST /csrf_token`. `goSession()` answers the session
 * with `post(path, body)`, or with `wall` (signed out) or `error` (a fault
 * named in words, never the page's text).
 */
export const goSession = `
const goSession = async (forceRefresh = false) => {
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
  const reads = new Set([
    "/3.0/paymentmethods", "/3.0/routestats", "/3.0/taxiontheway",
    "/4.0/persuggest/v1/finalsuggest", "/4.0/persuggest/v1/suggest", "/4.0/orderhistory/v2/list",
  ]);
  const request = async (path, options, read) => {
    let response;
    try { response = await fetch(origin + path, options); }
    catch (error) { if (!read) throw error; }
    if (read && (!response || [500, 502, 503, 504].includes(response.status) &&
        response.headers?.get("x-yataxi-retry-action")?.toLowerCase() !== "stop" &&
        !response.headers?.has("retry-after") && !response.headers?.has("x-yataxi-retry-interval-ms"))) {
      await new Promise((done) => setTimeout(done, 700));
      return fetch(origin + path, options);
    }
    return response;
  };
  const common = {
    "content-type": "application/json",
    "x-requested-with": "XMLHttpRequest",
    "x-retpath-y": "https://taxi.yandex.ru/captcha-success",
  };
  const base = {
    ...common,
    "x-yataxi-userid": userId,
    "x-taxi": navigator.userAgent + " turboapp_taxi",
    "accept-language": "ru",
    "x-request-id": crypto.randomUUID(),
  };
  let token;
  try {
    if (forceRefresh) localStorage.removeItem("csrf_token");
    const cached = JSON.parse(localStorage.getItem("csrf_token") || "null");
    if (!forceRefresh && typeof cached?.token === "string" && cached.token &&
        Number.isFinite(cached.validUntil) && cached.validUntil > Date.now()) token = cached.token;
  } catch {}
  if (!token) {
    const started = Date.now();
    const csrf = await request("/csrf_token", {
      method: "POST",
      redirect: "error",
      headers: common,
      credentials: "include",
      cache: "reload",
      body: "{}",
    }, true);
    if (csrf.status === 401) return { wall: "signed_out" };
    if (csrf.status !== 200) return { error: "csrf_" + csrf.status };
    const data = await csrf.json();
    if (typeof data?.sk !== "string" || !data.sk) return { error: "csrf_invalid" };
    token = data.sk;
    const ttl = data["max-age-seconds"];
    if (Number.isFinite(ttl) && ttl > 60) {
      try {
        localStorage.setItem("csrf_token", JSON.stringify({ token, validUntil: started + (ttl - 60) * 1000 }));
      } catch {}
    }
  }
  const headers = { ...base, "x-csrf-token": token };
  let renewedPost;
  const post = async (path, body, canRefresh = true) => {
    if (renewedPost) return renewedPost(path, body, canRefresh);
    const r = await request(path, {
      method: "POST",
      redirect: "error",
      headers,
      credentials: "include",
      body: JSON.stringify(body),
    }, reads.has(path));
    if (r.status !== 200) {
      const error = await r.json().catch(() => null);
      if ([400, 401, 403].includes(r.status) &&
          (error?.code === "INVALID_CSRF_TOKEN" || error?.error === "INVALID_CSRF_TOKEN")) {
        if (!canRefresh || !reads.has(path) || r.headers?.get("x-yataxi-retry-action")?.toLowerCase() === "stop" ||
            r.headers?.has("retry-after") || r.headers?.has("x-yataxi-retry-interval-ms")) return { error: "csrf_invalid" };
        const refreshed = await goSession(true);
        if (refreshed.wall || refreshed.error) return refreshed;
        if (refreshed.userId !== userId) return { error: "account_changed" };
        renewedPost = refreshed.post;
        return renewedPost(path, body, false);
      }
      return r.status === 401 ? { wall: "signed_out" } : { error: "http_" + r.status };
    }
    return r.json();
  };
  return { post, userId };
};
const goAnswer = (x) =>
  x.wall ? { status: "signed_out" } : x.error ? { status: "ok", data: { error: x.error } } : null;
`;

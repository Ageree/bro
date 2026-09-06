import { chatCompletionsUrl, type LlmRoute } from "./llm-routes.ts";
import {
  createKeyPool,
  pickKey,
  shouldAdvanceModel,
  shouldRotateKey,
  type KeyPool,
} from "./openrouter-pool.ts";

const REFERER = "https://bro-agent.vercel.app";

export type RotateEvent = {
  key: string;
  model: string | undefined;
  status: number;
  route?: string;
};

export type RotatingFetchOpts = {
  keys: string[];
  models: string[];
  fetch?: typeof fetch;
  now?: () => number;
  pool?: KeyPool;
  onRotate?: (event: RotateEvent) => void;
};

export type RoutedFetchOpts = {
  routes: LlmRoute[];
  fetch?: typeof fetch;
  now?: () => number;
  onRotate?: (event: RotateEvent) => void;
};

async function bodyToString(body: BodyInit | null | undefined): Promise<string | undefined> {
  if (body == null) return undefined;
  if (typeof body === "string") return body;
  if (body instanceof URLSearchParams) return body.toString();
  if (typeof Buffer !== "undefined" && Buffer.isBuffer(body)) {
    return body.toString("utf8");
  }
  if (body instanceof ArrayBuffer) return new TextDecoder().decode(body);
  if (ArrayBuffer.isView(body)) {
    return new TextDecoder().decode(new Uint8Array(body.buffer, body.byteOffset, body.byteLength));
  }
  if (typeof Blob !== "undefined" && body instanceof Blob) return await body.text();
  return undefined;
}

async function requestParts(
  input: RequestInfo | URL,
  init?: RequestInit,
): Promise<{
  url: string;
  method: string;
  headers: Headers;
  body: string | undefined;
  signal: AbortSignal | undefined;
}> {
  if (input instanceof Request) {
    const headers = new Headers(input.headers);
    if (init?.headers) {
      new Headers(init.headers).forEach((value, key) => headers.set(key, value));
    }
    const body =
      init?.body !== undefined ? await bodyToString(init.body) : await input.clone().text();
    return {
      url: input.url,
      method: (init?.method ?? input.method) || "GET",
      headers,
      body: body || undefined,
      signal: init?.signal ?? input.signal,
    };
  }
  return {
    url: String(input),
    method: init?.method ?? "GET",
    headers: new Headers(init?.headers),
    body: await bodyToString(init?.body),
    signal: init?.signal ?? undefined,
  };
}

function isChatBody(url: string, body: string | undefined): body is string {
  if (!body) return false;
  return /\/chat\/completions|\/responses(?:\?|$)/.test(url);
}

export function rewriteChatModel(body: string, model: string): string {
  try {
    const parsed: unknown = JSON.parse(body);
    if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) {
      return JSON.stringify({ ...parsed, model });
    }
  } catch {
    /* leave non-JSON bodies alone */
  }
  return body;
}

function replayResponse(status: number, headers: Headers, text: string): Response {
  return new Response(text, { status, headers });
}

/**
 * Fetch wrapper that retries across official provider routes, then keys
 * inside each route. Success bodies (including streams) are returned
 * unread. Error bodies are buffered so the attempt can move on.
 */
export function createRoutedFetch(opts: RoutedFetchOpts): typeof fetch {
  const doFetch = opts.fetch ?? fetch;
  const pools = new Map<string, KeyPool>();
  function poolFor(route: LlmRoute): KeyPool {
    const id = `${route.baseURL}\n${route.keys.join("\n")}`;
    const existing = pools.get(id);
    if (existing) return existing;
    const created = createKeyPool(route.keys, { now: opts.now });
    pools.set(id, created);
    return created;
  }

  return async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const parts = await requestParts(input, init);
    const canReroute = isChatBody(parts.url, parts.body);
    let last: Response | undefined;

    for (const route of opts.routes) {
      const pool = poolFor(route);
      if (pool.size === 0) continue;
      const attempted = new Set<string>();
      const url = canReroute ? chatCompletionsUrl(route.baseURL) : parts.url;
      while (attempted.size < pool.size) {
        const key = pickKey(pool, attempted, opts.now?.());
        if (!key) break;
        attempted.add(key);

        const headers = new Headers(parts.headers);
        headers.set("Authorization", `Bearer ${key}`);
        if (!headers.has("HTTP-Referer") && !headers.has("http-referer")) {
          headers.set("HTTP-Referer", REFERER);
        }
        if (!headers.has("X-Title") && !headers.has("x-title")) {
          headers.set("X-Title", "Bro");
        }

        let body = parts.body;
        if (canReroute && body) {
          body = rewriteChatModel(body, route.model);
        }

        let res: Response;
        try {
          res = await doFetch(url, {
            method: parts.method,
            headers,
            body,
            signal: parts.signal,
          });
        } catch (err) {
          pool.markFailure(key, 503, opts.now?.());
          opts.onRotate?.({ key, model: route.model, status: 503, route: route.id });
          last = new Response(err instanceof Error ? err.message : String(err), {
            status: 503,
          });
          continue;
        }

        if (res.ok) {
          pool.markSuccess(key);
          return res;
        }

        const text = await res.text().catch(() => "");
        last = replayResponse(res.status, res.headers, text);

        if (shouldRotateKey(res.status)) {
          pool.markFailure(key, res.status, opts.now?.());
          opts.onRotate?.({
            key,
            model: route.model,
            status: res.status,
            route: route.id,
          });
          continue;
        }
        if (shouldAdvanceModel(res.status, text)) {
          opts.onRotate?.({
            key,
            model: route.model,
            status: res.status,
            route: route.id,
          });
          break;
        }
        return last;
      }
    }

    return last ?? new Response("llm routes exhausted", { status: 502 });
  };
}

export function createOpenRouterFetch(opts: RotatingFetchOpts): typeof fetch {
  const models = opts.models.length > 0 ? opts.models : [undefined];
  const routes: LlmRoute[] = models.map((model, index) => ({
    id: `openrouter:${model ?? index}`,
    baseURL: "https://openrouter.ai/api/v1",
    keys: opts.keys,
    model: model ?? "openrouter/free",
  }));
  return createRoutedFetch({
    routes,
    fetch: opts.fetch,
    now: opts.now,
    onRotate: opts.onRotate,
  });
}

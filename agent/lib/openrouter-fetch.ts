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
};

export type RotatingFetchOpts = {
  keys: string[];
  models: string[];
  fetch?: typeof fetch;
  now?: () => number;
  pool?: KeyPool;
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
 * Fetch wrapper that retries across operator-owned keys, then across the
 * cheap model cascade. Success bodies (including streams) are returned
 * unread. Error bodies are buffered so the attempt can move on.
 */
export function createOpenRouterFetch(opts: RotatingFetchOpts): typeof fetch {
  const pool = opts.pool ?? createKeyPool(opts.keys, { now: opts.now });
  const doFetch = opts.fetch ?? fetch;
  const models = opts.models.length > 0 ? opts.models : [undefined];

  return async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const parts = await requestParts(input, init);
    let last: Response | undefined;

    for (const model of models) {
      const attempted = new Set<string>();
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
        if (model && isChatBody(parts.url, body)) {
          body = rewriteChatModel(body, model);
        }

        let res: Response;
        try {
          res = await doFetch(parts.url, {
            method: parts.method,
            headers,
            body,
            signal: parts.signal,
          });
        } catch (err) {
          pool.markFailure(key, 503, opts.now?.());
          opts.onRotate?.({ key, model, status: 503 });
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
          opts.onRotate?.({ key, model, status: res.status });
          continue;
        }
        if (shouldAdvanceModel(res.status, text)) {
          opts.onRotate?.({ key, model, status: res.status });
          break;
        }
        return last;
      }
    }

    return last ?? new Response("openrouter pool exhausted", { status: 502 });
  };
}

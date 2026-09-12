import { readFileSync } from "node:fs";

export function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(msg);
}

export function src(rel: string): string {
  return readFileSync(new URL("../../" + rel, import.meta.url), "utf8");
}

export function srcJson<T = unknown>(rel: string): T {
  return JSON.parse(src(rel)) as T;
}

export function eq<T>(got: T, want: T, msg: string): void {
  if (got !== want) throw new Error(`${msg}: got ${JSON.stringify(got)} want ${JSON.stringify(want)}`);
}

export function throws(fn: () => unknown, msg: string, contains?: string): void {
  try {
    fn();
  } catch (err) {
    if (contains !== undefined) {
      const text = err instanceof Error ? err.message : String(err);
      assert(text.includes(contains), `${msg}: got "${text}"`);
    }
    return;
  }
  throw new Error(msg);
}

// Sets `vars` (deleting keys mapped to undefined), runs `fn`, then restores
// the original values of exactly those keys — even if `fn` throws or further
// mutates them itself.
export function withEnv(vars: Record<string, string | undefined>, fn: () => void): void {
  const saved: Record<string, string | undefined> = {};
  for (const k of Object.keys(vars)) saved[k] = process.env[k];
  for (const [k, v] of Object.entries(vars)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  try {
    fn();
  } finally {
    for (const k of Object.keys(saved)) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  }
}

export type FetchCall = { url: string; body?: string };

export function makeFetch(
  handler: (url: string, init?: RequestInit) => Response | Promise<Response>,
): { fetch: typeof fetch; calls: FetchCall[] } {
  const calls: FetchCall[] = [];
  const fn = async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, body: typeof init?.body === "string" ? init.body : undefined });
    return handler(url, init);
  };
  return { fetch: fn as typeof fetch, calls };
}

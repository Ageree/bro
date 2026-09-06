/**
 * Operator-owned OpenRouter key pool + cheap model cascade.
 *
 * Keys must belong to the operator. This is not a scraper for leaked keys
 * and does not create accounts. OpenRouter free-tier limits are usually
 * per account, so extra keys from the same account do not multiply the
 * daily free quota — they only help when one key is 401/402/429 and
 * another still works.
 */

export const DEFAULT_OPENROUTER_MODEL = "openrouter/free";
export const DEFAULT_OPENROUTER_CONTEXT_TOKENS = 200_000;
export const PAID_GLM_MODEL = "z-ai/glm-5.3-flash";
export const PAID_GLM_CONTEXT_TOKENS = 1_000_000;

/** Tried after the primary when that model/key is rate-limited or missing. */
export const DEFAULT_MODEL_FALLBACKS = [
  "z-ai/glm-5.2:free",
  "google/gemma-4-31b-it:free",
] as const;

export const DEFAULT_KEY_COOLDOWN_MS = 15_000;
export const KEY_COOLDOWN_401_MS = 60 * 60_000;
export const KEY_COOLDOWN_402_MS = 5 * 60_000;
export const KEY_COOLDOWN_429_MS = 30_000;

export function splitList(raw: string | undefined): string[] {
  if (!raw?.trim()) return [];
  const out: string[] = [];
  const seen = new Set<string>();
  for (const part of raw.split(/[\s,]+/)) {
    const t = part.trim();
    if (!t || seen.has(t)) continue;
    seen.add(t);
    out.push(t);
  }
  return out;
}

export function parseOpenRouterKeys(
  env: NodeJS.ProcessEnv | Record<string, string | undefined>,
): string[] {
  const keys: string[] = [];
  const seen = new Set<string>();
  for (const chunk of [env.OPENROUTER_API_KEY, env.OPENROUTER_API_KEYS]) {
    for (const key of splitList(chunk)) {
      if (seen.has(key)) continue;
      seen.add(key);
      keys.push(key);
    }
  }
  return keys;
}

export function parseModelCascade(
  env: NodeJS.ProcessEnv | Record<string, string | undefined>,
): string[] {
  const primary = env.BRO_MODEL?.trim() || DEFAULT_OPENROUTER_MODEL;
  const fallbacks =
    env.BRO_MODEL_FALLBACKS === undefined
      ? [...DEFAULT_MODEL_FALLBACKS]
      : splitList(env.BRO_MODEL_FALLBACKS);
  const out: string[] = [];
  const seen = new Set<string>();
  for (const model of [primary, ...fallbacks]) {
    if (!model || seen.has(model)) continue;
    seen.add(model);
    out.push(model);
  }
  return out;
}

export function parseContextTokens(raw: string | undefined): number | undefined {
  const trimmed = raw?.trim();
  if (!trimmed) return undefined;
  const tokens = Number(trimmed);
  if (!Number.isInteger(tokens) || tokens <= 0) return undefined;
  return tokens;
}

export function contextTokensFor(
  model: string,
  env: NodeJS.ProcessEnv | Record<string, string | undefined>,
): number | undefined {
  const override = parseContextTokens(env.BRO_MODEL_CONTEXT_TOKENS);
  if (override !== undefined) return override;
  if (model === PAID_GLM_MODEL) return PAID_GLM_CONTEXT_TOKENS;
  if (model === DEFAULT_OPENROUTER_MODEL) return DEFAULT_OPENROUTER_CONTEXT_TOKENS;
  return undefined;
}

export function cooldownMsForStatus(status: number): number {
  if (status === 401) return KEY_COOLDOWN_401_MS;
  if (status === 402) return KEY_COOLDOWN_402_MS;
  if (status === 429) return KEY_COOLDOWN_429_MS;
  return DEFAULT_KEY_COOLDOWN_MS;
}

/** This key should be skipped for a while; try the next one. */
export function shouldRotateKey(status: number): boolean {
  return (
    status === 401 ||
    status === 402 ||
    status === 429 ||
    status === 408 ||
    (status >= 500 && status < 600)
  );
}

/** This model/provider combo is the problem; try the next model. */
export function shouldAdvanceModel(status: number, body: string): boolean {
  if (status === 404) return true;
  if (status === 400 || status === 422) {
    const m = body.toLowerCase();
    return /model|not found|no endpoints|unsupported|unavailable/.test(m);
  }
  return false;
}

export type KeyPool = {
  readonly size: number;
  next(now?: number): string | undefined;
  leftover(attempted: ReadonlySet<string>): string | undefined;
  markFailure(key: string, status: number, now?: number): void;
  markSuccess(key: string): void;
  healthyCount(now?: number): number;
};

export function createKeyPool(
  keys: string[],
  opts?: { now?: () => number },
): KeyPool {
  const unique: string[] = [];
  const seen = new Set<string>();
  for (const key of keys) {
    const t = key.trim();
    if (!t || seen.has(t)) continue;
    seen.add(t);
    unique.push(t);
  }
  const cooldownUntil = new Map<string, number>();
  let cursor = 0;
  const nowFn = opts?.now ?? Date.now;

  function healthy(now: number): string[] {
    return unique.filter((key) => (cooldownUntil.get(key) ?? 0) <= now);
  }

  return {
    get size() {
      return unique.length;
    },
    next(now = nowFn()) {
      const ok = healthy(now);
      if (ok.length === 0) return undefined;
      const key = ok[cursor % ok.length]!;
      cursor = (cursor + 1) % Math.max(ok.length, 1);
      return key;
    },
    leftover(attempted) {
      return unique.find((key) => !attempted.has(key));
    },
    markFailure(key, status, now = nowFn()) {
      cooldownUntil.set(key, now + cooldownMsForStatus(status));
    },
    markSuccess(key) {
      cooldownUntil.delete(key);
    },
    healthyCount(now = nowFn()) {
      return healthy(now).length;
    },
  };
}

export function pickKey(
  pool: KeyPool,
  attempted: ReadonlySet<string>,
  now?: number,
): string | undefined {
  const next = pool.next(now);
  if (next && !attempted.has(next)) return next;
  return pool.leftover(attempted);
}

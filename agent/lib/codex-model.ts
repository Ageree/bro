import { createOpenAI } from "@ai-sdk/openai";
import { APICallError } from "ai";

export const DEFAULT_CODEX_MODEL = "gpt-5.6-sol";
export const CODEX_RESPONSES_URL = "https://chatgpt.com/backend-api/codex/responses";
export const CODEX_CONTEXT_WINDOW_TOKENS = 200_000;

export type CodexTokenReason = "request" | "rejected";

export type CodexBrokerToken = {
  accessToken: string;
  accountId?: string;
};

export type CodexTokenBroker = {
  getToken(input: { reason: CodexTokenReason }): Promise<CodexBrokerToken>;
  state?: () => { accountId?: string } | { kind?: string; accountId?: string };
};

export type LanguageModelLike = {
  doGenerate: (...args: never[]) => Promise<unknown>;
  doStream: (...args: never[]) => Promise<unknown>;
  [key: string]: unknown;
};

const FALLBACK_STATUSES = new Set([401, 402, 429]);

function requireModelId(model: string): string {
  const id = model.trim();
  if (!id) throw new Error("model required");
  return id;
}

function requireBroker(broker: CodexTokenBroker): CodexTokenBroker {
  if (typeof broker?.getToken !== "function") {
    throw new Error("broker.getToken required");
  }
  return broker;
}

function requestUrl(input: RequestInfo | URL): string {
  if (typeof input === "string") return input;
  if (input instanceof URL) return input.href;
  return input.url;
}

export function rewriteCodexResponsesUrl(
  input: string,
  codexApiEndpoint: string = CODEX_RESPONSES_URL,
): string {
  if (typeof input !== "string" || input.length === 0) return input;
  if (!input.includes("/v1/responses")) return input;
  try {
    const src = new URL(input);
    const dest = new URL(codexApiEndpoint);
    dest.search = src.search;
    return dest.toString();
  } catch {
    return codexApiEndpoint;
  }
}

function accountIdFromBroker(
  broker: CodexTokenBroker,
  token: CodexBrokerToken,
): string | undefined {
  if (typeof token.accountId === "string" && token.accountId.length > 0) {
    return token.accountId;
  }
  const state = typeof broker.state === "function" ? broker.state() : undefined;
  if (state && typeof state === "object" && typeof state.accountId === "string") {
    return state.accountId.length > 0 ? state.accountId : undefined;
  }
  return undefined;
}

function applyCodexHeaders(
  headers: Headers,
  token: CodexBrokerToken,
  broker: CodexTokenBroker,
): void {
  headers.set("Authorization", `Bearer ${token.accessToken}`);
  const accountId = accountIdFromBroker(broker, token);
  if (accountId) headers.set("ChatGPT-Account-Id", accountId);
}

export function createCodexFetch(opts: {
  broker: CodexTokenBroker;
  fetch?: typeof globalThis.fetch;
  codexApiEndpoint?: string;
}): typeof globalThis.fetch {
  const broker = requireBroker(opts.broker);
  const base = opts.fetch ?? globalThis.fetch;
  const endpoint = opts.codexApiEndpoint ?? CODEX_RESPONSES_URL;
  return async (input, init) => {
    const source = input instanceof Request ? input : undefined;
    const url = rewriteCodexResponsesUrl(requestUrl(input), endpoint);
    const headers = new Headers(init?.headers ?? source?.headers);
    const first = await broker.getToken({ reason: "request" });
    if (typeof first.accessToken !== "string" || first.accessToken.length === 0) {
      throw new Error("broker returned an empty access token");
    }
    applyCodexHeaders(headers, first, broker);
    const requestInit: RequestInit = {
      method: init?.method ?? source?.method,
      body: init?.body ?? source?.body,
      headers,
      redirect: init?.redirect ?? source?.redirect,
      signal: init?.signal ?? source?.signal,
    };
    const response = await base(url, requestInit);
    if (response.status !== 401) return response;
    const retry = await broker.getToken({ reason: "rejected" });
    if (typeof retry.accessToken !== "string" || retry.accessToken.length === 0) {
      throw new Error("broker returned an empty access token");
    }
    const retryHeaders = new Headers(init?.headers ?? source?.headers);
    applyCodexHeaders(retryHeaders, retry, broker);
    return await base(url, { ...requestInit, headers: retryHeaders });
  };
}

export function createCodexModel(input: {
  model: string;
  broker: CodexTokenBroker;
  fetch?: typeof globalThis.fetch;
}): LanguageModelLike {
  if (typeof input !== "object" || input === null) {
    throw new Error("createCodexModel input required");
  }
  const model = requireModelId(input.model);
  const openai = createOpenAI({
    apiKey: "codex",
    name: "chatgpt-codex",
    fetch: createCodexFetch({
      broker: input.broker,
      fetch: input.fetch,
    }),
  });
  return openai.responses(model) as unknown as LanguageModelLike;
}

function fallbackStatus(error: unknown): number | undefined {
  if (APICallError.isInstance(error)) return error.statusCode;
  if (error instanceof APICallError) return error.statusCode;
  return undefined;
}

export function isCodexFallbackError(error: unknown): boolean {
  const status = fallbackStatus(error);
  return status !== undefined && FALLBACK_STATUSES.has(status);
}

/** Switch to fallback only when the primary call fails before any chunk. */
export function withFallback<T extends LanguageModelLike>(
  primary: T,
  fallback: T,
  onFail: (error: unknown) => unknown,
): T {
  if (typeof primary?.doGenerate !== "function" || typeof primary.doStream !== "function") {
    throw new Error("primary model must implement doGenerate/doStream");
  }
  if (typeof fallback?.doGenerate !== "function" || typeof fallback.doStream !== "function") {
    throw new Error("fallback model must implement doGenerate/doStream");
  }
  if (typeof onFail !== "function") throw new Error("onFail required");

  const run = async (
    method: "doGenerate" | "doStream",
    args: never[],
  ): Promise<unknown> => {
    try {
      return await primary[method](...args);
    } catch (error) {
      if (!isCodexFallbackError(error)) throw error;
      await onFail(error);
      return await fallback[method](...args);
    }
  };

  return {
    ...primary,
    doGenerate: (...args: never[]) => run("doGenerate", args),
    doStream: (...args: never[]) => run("doStream", args),
  };
}

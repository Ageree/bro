import { randomBytes } from "node:crypto";
import { APICallError } from "ai";
import {
  CODEX_RESPONSES_URL,
  CodexUnavailableError,
  createCodexFetch,
  rewriteCodexResponsesUrl,
  withFallback,
  type LanguageModelLike,
} from "../agent/lib/codex-model.ts";
import {
  CHATGPT_OAUTH_HANDLE,
  parseChatgptOAuthJson,
  refreshChatgptAccessToken,
  startDeviceAuth,
} from "../agent/lib/chatgpt-oauth.ts";
import {
  CODEX_CONTEXT_WINDOW_TOKENS,
  resolveBroModel,
} from "../agent/lib/model.ts";
import {
  devicePollSleepMs,
  groupUsesOpenRouter,
  loginExpired,
  nextLoginStatus,
  shouldRefresh,
  snapshotStatus,
} from "../convex/lib/chatgptPolicy.ts";
import {
  decryptVaultSecret,
  encryptVaultSecret,
  vaultMasterKey,
} from "../shared/vaultCrypto.ts";

import { assert, src } from "./lib/check.ts";

assert(devicePollSleepMs(5) === 5_000, "interval 5s → 5000ms");
assert(devicePollSleepMs(5, 5) === 10_000, "slowDown adds seconds");
assert(devicePollSleepMs(0) === 1_000, "minimum one second");

assert(!shouldRefresh(1_000_000, 100_000, 120_000), "fresh token stays");
assert(shouldRefresh(200_000, 100_000, 120_000), "within margin refreshes");
assert(shouldRefresh(100_000, 100_000, 0), "exactly expired refreshes");

assert(!loginExpired(200, 100), "login still live");
assert(loginExpired(100, 100), "login expires at the instant");
assert(loginExpired(50, 100), "login already expired");

assert(
  nextLoginStatus({ status: "pending", expiresAt: 200, now: 100 }) === "pending",
  "pending stays pending",
);
assert(
  nextLoginStatus({ status: "pending", expiresAt: 50, now: 100 }) === "expired",
  "pending becomes expired",
);
assert(
  nextLoginStatus({ status: "authorized", expiresAt: 50, now: 100 }) === "done",
  "legacy authorized maps to done",
);
assert(
  nextLoginStatus({ status: "done", expiresAt: 50, now: 100 }) === "done",
  "done is not expired by clock",
);
assert(
  nextLoginStatus({ status: "failed", expiresAt: 50, now: 100 }) === "failed",
  "failed stays failed",
);

assert(groupUsesOpenRouter(true) === true, "group uses OpenRouter");
assert(groupUsesOpenRouter(false) === false, "1:1 may use Codex");

assert(
  snapshotStatus({ hasAccount: false }) === "none",
  "no account and no login → none",
);
assert(
  snapshotStatus({ hasAccount: false, loginStatus: "pending" }) === "pending",
  "device login in flight → pending",
);
assert(
  snapshotStatus({ hasAccount: true }) === "connected",
  "account without quarantine → connected",
);
assert(
  snapshotStatus({ hasAccount: true, quarantinedAt: 1, loginStatus: "pending" }) ===
    "quarantined",
  "quarantine wins",
);

assert(
  rewriteCodexResponsesUrl("https://api.openai.com/v1/responses") ===
    CODEX_RESPONSES_URL,
  "rewrites /v1/responses",
);
assert(
  rewriteCodexResponsesUrl("https://api.openai.com/v1/models") ===
    "https://api.openai.com/v1/models",
  "leaves other OpenAI paths alone",
);

const reasons: string[] = [];
const fetchMock: typeof fetch = async (input, init) => {
  const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
  const auth = new Headers(init?.headers).get("Authorization");
  const account = new Headers(init?.headers).get("ChatGPT-Account-Id");
  reasons.push(`${url}|${auth}|${account}`);
  if (reasons.length === 1) {
    return new Response("nope", { status: 401 });
  }
  return new Response("ok", { status: 200 });
};
const fetchFn = createCodexFetch({
  broker: {
    async getToken({ reason }) {
      return {
        accessToken: reason === "request" ? "first" : "second",
        accountId: "acct-1",
      };
    },
    state: () => ({ accountId: "acct-state" }),
  },
  fetch: fetchMock,
});
const retried = await fetchFn("https://api.openai.com/v1/responses", {
  method: "POST",
});
assert(retried.status === 200, "401 retries once");
assert(reasons[0]?.startsWith(`${CODEX_RESPONSES_URL}|Bearer first|acct-1`), "first hop");
assert(reasons[1]?.startsWith(`${CODEX_RESPONSES_URL}|Bearer second|acct-1`), "retry hop");

let failed = 0;
const boom = new APICallError({
  message: "rate limited",
  url: "https://chatgpt.com/backend-api/codex/responses",
  requestBodyValues: {},
  statusCode: 429,
});
const primary: LanguageModelLike = {
  doGenerate: async () => {
    throw boom;
  },
  doStream: async () => {
    throw boom;
  },
};
const fallback: LanguageModelLike = {
  doGenerate: async () => ({ text: "openrouter" }),
  doStream: async () => ({ stream: "openrouter" }),
};
const wrapped = withFallback(primary, fallback, () => {
  failed += 1;
});
const generated = (await wrapped.doGenerate()) as { text: string };
assert(generated.text === "openrouter", "429 doGenerate uses fallback");
assert(failed > 0, "onFail runs once for generate");
const streamed = (await wrapped.doStream()) as { stream: string };
assert(streamed.stream === "openrouter", "429 doStream uses fallback");
assert(failed === 2, "onFail runs for stream");

const startedStream: LanguageModelLike = {
  doGenerate: async () => ({ text: "primary" }),
  doStream: async () => ({ stream: "started" }),
};
let switched = 0;
const noSwitch = withFallback(startedStream, fallback, () => {
  switched += 1;
});
assert(
  ((await noSwitch.doStream()) as { stream: string }).stream === "started",
  "successful stream stays on primary",
);
assert(switched === 0, "do not switch after stream started");

const other = new APICallError({
  message: "server",
  url: "https://example.com",
  requestBodyValues: {},
  statusCode: 500,
});
const hard: LanguageModelLike = {
  doGenerate: async () => {
    throw other;
  },
  doStream: async () => {
    throw other;
  },
};
let hardFail = 0;
const noFallback = withFallback(hard, fallback, () => {
  hardFail += 1;
});
let threw = false;
try {
  await noFallback.doGenerate();
} catch (err) {
  threw = err === other;
}
assert(threw, "500 does not fall back");
assert(hardFail === 0, "onFail skipped for non-quota errors");

const getterPrimary: LanguageModelLike = {
  doGenerate: async () => ({ text: "ok" }),
  doStream: async () => ({ stream: "ok" }),
};
Object.defineProperty(getterPrimary, "provider", {
  get: () => "chatgpt-codex",
  enumerable: false,
});
Object.defineProperty(getterPrimary, "modelId", {
  get: () => "gpt-5.6-sol",
  enumerable: false,
});
const keptMeta = withFallback(getterPrimary, fallback, () => undefined);
assert(keptMeta.provider === "chatgpt-codex", "provider getter survives wrap");
assert(keptMeta.modelId === "gpt-5.6-sol", "modelId getter survives wrap");

let unavailableFail = 0;
const missing: LanguageModelLike = {
  doGenerate: async () => {
    throw new CodexUnavailableError("broker down");
  },
  doStream: async () => {
    throw new CodexUnavailableError("broker down");
  },
};
const recovered = withFallback(missing, fallback, () => {
  unavailableFail += 1;
});
assert(
  ((await recovered.doGenerate()) as { text: string }).text === "openrouter",
  "broker failure falls back",
);
assert(unavailableFail === 1, "onFail runs for unavailable");

process.env.BRO_VAULT_KEY = randomBytes(32).toString("base64");
const master = vaultMasterKey();
const tenantId = "tenants|chatgpt-check";
const oauthJson = JSON.stringify({
  access_token: "access",
  refresh_token: "refresh",
  expires_at: 1_700_000_000_000,
  account_id: "acct",
});
const sealed = encryptVaultSecret(master, tenantId, CHATGPT_OAUTH_HANDLE, oauthJson);
assert(sealed.startsWith("v1."), "chatgpt:oauth ciphertext is versioned");
assert(!sealed.includes("refresh"), "ciphertext must not leak the refresh token");
assert(
  decryptVaultSecret(master, tenantId, CHATGPT_OAUTH_HANDLE, sealed) === oauthJson,
  "chatgpt:oauth round trip",
);
assert(
  parseChatgptOAuthJson(oauthJson).refresh_token === "refresh",
  "oauth json parses",
);

const refreshed = await refreshChatgptAccessToken({
  refreshToken: "old-refresh",
  now: 1_000,
  fetch: async (_input, init) => {
    const body = String(init?.body);
    assert(body.includes("grant_type=refresh_token"), "refresh grant");
    assert(body.includes("refresh_token=old-refresh"), "refresh token sent");
    return new Response(
      JSON.stringify({
        access_token: "new-access",
        refresh_token: "new-refresh",
        expires_in: 60,
      }),
      { status: 200 },
    );
  },
});
assert(refreshed.ok && refreshed.tokens.access_token === "new-access", "refresh ok");

const invalid = await refreshChatgptAccessToken({
  refreshToken: "dead",
  fetch: async () =>
    new Response(JSON.stringify({ error: "invalid_grant" }), { status: 400 }),
});
assert(!invalid.ok && invalid.invalidGrant, "invalid_grant is flagged");

const started = await startDeviceAuth({
  now: 5_000,
  fetch: async (input, init) => {
    assert(String(input).includes("/deviceauth/usercode"), "usercode url");
    const body = JSON.parse(String(init?.body)) as { client_id?: string };
    assert(body.client_id?.startsWith("app_"), "public Codex client id");
    return new Response(
      JSON.stringify({
        device_auth_id: "dev-1",
        user_code: "ABCD-1234",
        interval: 5,
      }),
      { status: 200 },
    );
  },
});
assert(started.url === "https://auth.openai.com/codex/device", "verify url");
assert(started.userCode === "ABCD-1234", "user code");
assert(started.deviceAuthId === "dev-1", "device auth id");

process.env.OPENROUTER_API_KEY = "test";
const { broModel } = await import("../agent/lib/model.ts");
const openrouter = broModel();
const group = resolveBroModel(
  { isGroup: true, chatgpt: "connected" },
  {
    broker: {
      getToken: async () => ({ accessToken: "tok" }),
    },
  },
);
assert(
  typeof group.model === "object" &&
    group.model !== null &&
    "modelId" in group.model &&
    typeof openrouter.model === "object" &&
    openrouter.model !== null &&
    "modelId" in openrouter.model &&
    group.model.modelId === openrouter.model.modelId,
  "group → OpenRouter path",
);
assert(groupUsesOpenRouter(true), "group policy agrees");
assert(
  !("modelContextWindowTokens" in group) ||
    group.modelContextWindowTokens === openrouter.modelContextWindowTokens,
  "group keeps the OpenRouter window",
);

const connected = resolveBroModel(
  { isGroup: false, chatgpt: "connected" },
  {
    broker: {
      getToken: async () => ({ accessToken: "tok", accountId: "acct" }),
    },
  },
);
assert(
  connected.modelContextWindowTokens === CODEX_CONTEXT_WINDOW_TOKENS,
  "connected + broker uses the 200k Codex window",
);

const chatgptSrc = src("convex/chatgpt.ts");
assert(chatgptSrc.includes("scheduleDevicePoll"), "login start schedules the poller");
assert(chatgptSrc.includes("pollDeviceLogin"), "poller is the internal ChatGPT action");
assert(chatgptSrc.includes("status: \"done\""), "finishLogin writes done, not authorized");

const connectSrc = src("agent/tools/chatgpt_connect.ts");
assert(connectSrc.includes("Я сам проверю вход"), "connect tool says polling is on");
assert(connectSrc.includes("startLoginForAgent"), "connect tool starts login in Convex");
assert(!connectSrc.includes("startDeviceAuth"), "connect tool does not talk to OpenAI");
assert(!connectSrc.includes("ещё не подключён"), "connect tool no longer says polling is off");

const secretsSrc = src("convex/chatgptSecrets.ts");
assert(secretsSrc.includes("pollDeviceAuth"), "secrets poller talks to deviceauth");
assert(secretsSrc.includes("exchangeDeviceCode"), "secrets poller exchanges the code");
assert(secretsSrc.includes("startDeviceLoginForTenant"), "cabinet start is an internal action");
assert(secretsSrc.includes("startLoginForAgent"), "agent start is a secret-gated action");
assert(secretsSrc.includes("disconnectForTenant"), "cabinet disconnect is internal");

console.log("chatgpt:check OK");

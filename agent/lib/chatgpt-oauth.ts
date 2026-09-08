/**
 * Codex / ChatGPT OAuth helpers. Device start, poll, code exchange, refresh.
 * Fetch is injectable so checks can run without the network.
 */

export const CODEX_CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";
export const CODEX_ISSUER = "https://auth.openai.com";
export const CODEX_DEVICE_VERIFY_URL = `${CODEX_ISSUER}/codex/device`;
export const CODEX_DEVICE_USERCODE_URL = `${CODEX_ISSUER}/api/accounts/deviceauth/usercode`;
export const CODEX_DEVICE_TOKEN_URL = `${CODEX_ISSUER}/api/accounts/deviceauth/token`;
export const CODEX_OAUTH_TOKEN_URL = `${CODEX_ISSUER}/oauth/token`;
export const CODEX_DEVICE_REDIRECT_URI = `${CODEX_ISSUER}/deviceauth/callback`;
export const CHATGPT_OAUTH_HANDLE = "chatgpt:oauth";
export const DEVICE_LOGIN_TTL_MS = 15 * 60 * 1000;

export type ChatgptOAuthTokens = {
  access_token: string;
  refresh_token: string;
  id_token?: string;
  expires_at: number;
  account_id?: string;
};

export type DeviceStart = {
  deviceAuthId: string;
  userCode: string;
  interval: number;
  expiresAt: number;
  url: string;
};

export type DevicePollResult =
  | { status: "pending" }
  | { status: "slow_down" }
  | { status: "ok"; authorizationCode: string; codeVerifier: string }
  | { status: "error"; message: string };

export type RefreshResult =
  | { ok: true; tokens: ChatgptOAuthTokens }
  | { ok: false; invalidGrant: boolean; message: string };

type FetchFn = typeof globalThis.fetch;

function requireText(name: string, value: unknown): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`${name} required`);
  }
  return value.trim();
}

function runner(fetchImpl?: FetchFn): FetchFn {
  return fetchImpl ?? globalThis.fetch;
}

function readInterval(raw: unknown): number {
  if (typeof raw === "number" && Number.isFinite(raw) && raw >= 0) return raw;
  if (typeof raw === "string") {
    const n = Number(raw.trim());
    if (Number.isFinite(n) && n >= 0) return n;
  }
  return 5;
}

export function accountIdFromJwt(token: string): string | undefined {
  const parts = token.split(".");
  const payload = parts[1];
  if (!payload) return undefined;
  try {
    const json = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as {
      chatgpt_account_id?: unknown;
      "https://api.openai.com/auth"?: { chatgpt_account_id?: unknown };
    };
    const nested = json["https://api.openai.com/auth"]?.chatgpt_account_id;
    const id = typeof nested === "string" ? nested : json.chatgpt_account_id;
    return typeof id === "string" && id.length > 0 ? id : undefined;
  } catch {
    return undefined;
  }
}

export function parseChatgptOAuthJson(json: string): ChatgptOAuthTokens {
  let parsed: unknown;
  try {
    parsed = JSON.parse(requireText("json", json));
  } catch {
    throw new Error("chatgpt oauth json is not valid JSON");
  }
  if (typeof parsed !== "object" || parsed === null) {
    throw new Error("chatgpt oauth json must be an object");
  }
  const row = parsed as {
    access_token?: unknown;
    refresh_token?: unknown;
    id_token?: unknown;
    expires_at?: unknown;
    account_id?: unknown;
  };
  const access = requireText("access_token", row.access_token);
  const refresh = requireText("refresh_token", row.refresh_token);
  if (typeof row.expires_at !== "number" || !Number.isFinite(row.expires_at)) {
    throw new Error("expires_at must be a finite number");
  }
  const tokens: ChatgptOAuthTokens = {
    access_token: access,
    refresh_token: refresh,
    expires_at: row.expires_at,
  };
  if (typeof row.id_token === "string" && row.id_token.length > 0) {
    tokens.id_token = row.id_token;
  }
  const accountId =
    typeof row.account_id === "string" && row.account_id.length > 0
      ? row.account_id
      : accountIdFromJwt(access);
  if (accountId) tokens.account_id = accountId;
  return tokens;
}

function tokensFromOauthBody(
  body: Record<string, unknown>,
  now: number,
  previousRefresh?: string,
): ChatgptOAuthTokens {
  const access = requireText("access_token", body.access_token);
  const refreshRaw = body.refresh_token;
  const refresh =
    typeof refreshRaw === "string" && refreshRaw.length > 0
      ? refreshRaw
      : previousRefresh;
  if (!refresh) throw new Error("refresh_token missing");
  const expiresIn =
    typeof body.expires_in === "number" && Number.isFinite(body.expires_in)
      ? body.expires_in
      : 3600;
  const tokens: ChatgptOAuthTokens = {
    access_token: access,
    refresh_token: refresh,
    expires_at: now + Math.max(1, expiresIn) * 1000,
  };
  if (typeof body.id_token === "string" && body.id_token.length > 0) {
    tokens.id_token = body.id_token;
  }
  const accountId = accountIdFromJwt(access);
  if (accountId) tokens.account_id = accountId;
  return tokens;
}

export async function startDeviceAuth(opts?: {
  fetch?: FetchFn;
  now?: number;
  clientId?: string;
}): Promise<DeviceStart> {
  const fetchImpl = runner(opts?.fetch);
  const now = opts?.now ?? Date.now();
  const clientId = opts?.clientId?.trim() || CODEX_CLIENT_ID;
  const response = await fetchImpl(CODEX_DEVICE_USERCODE_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ client_id: clientId }),
  });
  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new Error(
      `device code start failed (${response.status})${text ? `: ${text}` : ""}`,
    );
  }
  const json = (await response.json()) as {
    device_auth_id?: unknown;
    user_code?: unknown;
    usercode?: unknown;
    interval?: unknown;
    expires_at?: unknown;
  };
  const deviceAuthId = requireText("device_auth_id", json.device_auth_id);
  const userCode = requireText(
    "user_code",
    typeof json.user_code === "string" ? json.user_code : json.usercode,
  );
  let expiresAt = now + DEVICE_LOGIN_TTL_MS;
  if (typeof json.expires_at === "string") {
    const parsed = Date.parse(json.expires_at);
    if (Number.isFinite(parsed)) expiresAt = parsed;
  } else if (typeof json.expires_at === "number" && Number.isFinite(json.expires_at)) {
    expiresAt = json.expires_at < 1e12 ? json.expires_at * 1000 : json.expires_at;
  }
  return {
    deviceAuthId,
    userCode,
    interval: readInterval(json.interval),
    expiresAt,
    url: CODEX_DEVICE_VERIFY_URL,
  };
}

export async function pollDeviceAuth(opts: {
  deviceAuthId: string;
  userCode: string;
  fetch?: FetchFn;
}): Promise<DevicePollResult> {
  const fetchImpl = runner(opts.fetch);
  const response = await fetchImpl(CODEX_DEVICE_TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      device_auth_id: requireText("deviceAuthId", opts.deviceAuthId),
      user_code: requireText("userCode", opts.userCode),
    }),
  });
  if (response.status === 403 || response.status === 404) {
    return { status: "pending" };
  }
  const text = await response.text().catch(() => "");
  let json: {
    authorization_code?: unknown;
    code_verifier?: unknown;
    error?: unknown;
  } = {};
  try {
    json = text ? (JSON.parse(text) as typeof json) : {};
  } catch {
    json = {};
  }
  const error = typeof json.error === "string" ? json.error : "";
  if (error === "slow_down") return { status: "slow_down" };
  if (error === "deviceauth_authorization_pending") return { status: "pending" };
  if (!response.ok) {
    return {
      status: "error",
      message: `device poll failed (${response.status})${text ? `: ${text}` : ""}`,
    };
  }
  if (
    typeof json.authorization_code !== "string" ||
    typeof json.code_verifier !== "string"
  ) {
    return { status: "error", message: "device poll missing authorization_code" };
  }
  return {
    status: "ok",
    authorizationCode: json.authorization_code,
    codeVerifier: json.code_verifier,
  };
}

export async function exchangeDeviceCode(opts: {
  authorizationCode: string;
  codeVerifier: string;
  fetch?: FetchFn;
  now?: number;
  clientId?: string;
}): Promise<ChatgptOAuthTokens> {
  const fetchImpl = runner(opts.fetch);
  const now = opts.now ?? Date.now();
  const body = new URLSearchParams({
    grant_type: "authorization_code",
    code: requireText("authorizationCode", opts.authorizationCode),
    redirect_uri: CODEX_DEVICE_REDIRECT_URI,
    client_id: opts.clientId?.trim() || CODEX_CLIENT_ID,
    code_verifier: requireText("codeVerifier", opts.codeVerifier),
  });
  const response = await fetchImpl(CODEX_OAUTH_TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });
  const text = await response.text().catch(() => "");
  if (!response.ok) {
    throw new Error(
      `device code exchange failed (${response.status})${text ? `: ${text}` : ""}`,
    );
  }
  const json = JSON.parse(text) as Record<string, unknown>;
  return tokensFromOauthBody(json, now);
}

export async function refreshChatgptAccessToken(opts: {
  refreshToken: string;
  fetch?: FetchFn;
  now?: number;
  clientId?: string;
}): Promise<RefreshResult> {
  const fetchImpl = runner(opts.fetch);
  const now = opts.now ?? Date.now();
  const refreshToken = requireText("refreshToken", opts.refreshToken);
  const response = await fetchImpl(CODEX_OAUTH_TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: refreshToken,
      client_id: opts.clientId?.trim() || CODEX_CLIENT_ID,
    }),
  });
  const text = await response.text().catch(() => "");
  let json: Record<string, unknown> = {};
  try {
    json = text ? (JSON.parse(text) as Record<string, unknown>) : {};
  } catch {
    json = {};
  }
  const error = typeof json.error === "string" ? json.error : "";
  if (!response.ok) {
    return {
      ok: false,
      invalidGrant: error === "invalid_grant" || response.status === 401,
      message: `token refresh failed (${response.status})${text ? `: ${text}` : ""}`,
    };
  }
  try {
    return { ok: true, tokens: tokensFromOauthBody(json, now, refreshToken) };
  } catch (err) {
    return {
      ok: false,
      invalidGrant: false,
      message: err instanceof Error ? err.message : "token refresh parse failed",
    };
  }
}

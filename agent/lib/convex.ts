import { ConvexHttpClient } from "convex/browser";
import type { FunctionArgs, FunctionReference, FunctionReturnType } from "convex/server";
import { api } from "../../convex/_generated/api.js";
import type { Id } from "../../convex/_generated/dataModel";
import {
  HANDLE_TENANT_TTL_MS,
  TELEGRAM_TENANT_TTL_MS,
  createTtlCache,
} from "./inbound-path.ts";

let cachedClient: ConvexHttpClient | undefined;
let cachedClientUrl: string | undefined;

function client(): ConvexHttpClient {
  const url = process.env.CONVEX_URL;
  if (!url) throw new Error("CONVEX_URL missing");
  if (cachedClient && cachedClientUrl === url) return cachedClient;
  cachedClient = new ConvexHttpClient(url);
  cachedClientUrl = url;
  return cachedClient;
}

function secret(): string {
  const s = process.env.BRO_INTERNAL_SECRET;
  if (!s) throw new Error("BRO_INTERNAL_SECRET missing");
  return s;
}

/** Generic forwarders: call a Convex function with `secret` injected. */
const q =
  <F extends FunctionReference<"query">>(fn: F) =>
  (args: Omit<FunctionArgs<F>, "secret">): Promise<FunctionReturnType<F>> =>
    client().query(fn, { secret: secret(), ...args } as FunctionArgs<F>);

const m =
  <F extends FunctionReference<"mutation">>(fn: F) =>
  (args: Omit<FunctionArgs<F>, "secret">): Promise<FunctionReturnType<F>> =>
    client().mutation(fn, { secret: secret(), ...args } as FunctionArgs<F>);

const a =
  <F extends FunctionReference<"action">>(fn: F) =>
  (args: Omit<FunctionArgs<F>, "secret">): Promise<FunctionReturnType<F>> =>
    client().action(fn, { secret: secret(), ...args } as FunctionArgs<F>);

export type JobWakeRow = {
  id: string;
  line: string;
  goal: string;
  note?: string;
  waitingFor?: "human" | "email" | "browser";
  waitingSince?: number;
  lastNudgeAt?: number;
};

export type WakeContext = {
  memories: string[];
  jobs: JobWakeRow[];
};

const wakeInflight = new Map<string, Promise<WakeContext>>();
const wakeCache = new Map<string, { at: number; value: WakeContext }>();

export const WAKE_CONTEXT_TTL_MS = 8_000;

function rememberWake(phoneE164: string, value: WakeContext): void {
  wakeCache.set(phoneE164, { at: Date.now(), value });
}

function forgetWake(phoneE164: string): void {
  wakeCache.delete(phoneE164);
}

export async function loadWakeContext(phoneE164: string): Promise<WakeContext> {
  const cached = wakeCache.get(phoneE164);
  if (cached && Date.now() - cached.at < WAKE_CONTEXT_TTL_MS) return cached.value;
  const existing = wakeInflight.get(phoneE164);
  if (existing) return existing;
  const pending = q(api.memories.wakeContext)({ phoneE164 })
    .then((value) => {
      rememberWake(phoneE164, value);
      return value;
    })
    .finally(() => {
      wakeInflight.delete(phoneE164);
    });
  wakeInflight.set(phoneE164, pending);
  return pending;
}

export async function wakeLines(phoneE164: string): Promise<string[]> {
  return (await loadWakeContext(phoneE164)).memories;
}

export async function noteLine(phoneE164: string, line: string): Promise<string> {
  await m(api.memories.note)({ phoneE164, line });
  forgetWake(phoneE164);
  return "noted";
}

export const searchLines = (phoneE164: string, needle: string): Promise<string[]> =>
  q(api.memories.search)({ phoneE164, needle });

export async function forgetLines(phoneE164: string, needle: string): Promise<string> {
  const n = await m(api.memories.forget)({ phoneE164, needle });
  forgetWake(phoneE164);
  return `forgot ${n}`;
}

export async function upsertTenant(
  phoneE164: string,
  inkboxConversationId?: string,
  emailAddress?: string,
) {
  const tenant = await m(api.tenants.upsert)({
    phoneE164,
    inkboxConversationId,
    emailAddress,
  });
  if (tenant.inkboxHandle) forgetHandleTenant(tenant.inkboxHandle);
  if (tenant.telegramUserId) forgetTelegramTenant(tenant.telegramUserId);
  return tenant;
}

export const getTenant = (phoneE164: string) => q(api.tenants.getByPhone)({ phoneE164 });

type HandleTenant = FunctionReturnType<typeof api.tenants.getByHandle>;
type TelegramTenant = FunctionReturnType<typeof api.tenants.getByTelegram>;

const handleTenants = createTtlCache<HandleTenant>(HANDLE_TENANT_TTL_MS);
const handleInflight = new Map<string, Promise<HandleTenant>>();
const telegramTenants = createTtlCache<TelegramTenant>(TELEGRAM_TENANT_TTL_MS);
const telegramInflight = new Map<string, Promise<TelegramTenant>>();

export function forgetHandleTenant(handle: string): void {
  handleTenants.forget(handle.trim());
}

export function forgetTelegramTenant(telegramUserId: string): void {
  telegramTenants.forget(telegramUserId.trim());
}

function rememberHandleTenant(handle: string, tenant: HandleTenant): void {
  handleTenants.set(handle.trim(), tenant);
}

function rememberTelegramTenant(
  telegramUserId: string,
  tenant: TelegramTenant,
): void {
  telegramTenants.set(telegramUserId.trim(), tenant);
}

export async function getTenantByHandle(
  handle: string,
  opts?: { fresh?: boolean },
): Promise<HandleTenant> {
  const key = handle.trim();
  if (!opts?.fresh) {
    const cached = handleTenants.get(key);
    if (cached.hit) return cached.value;
    const existing = handleInflight.get(key);
    if (existing) return existing;
  }
  const pending = q(api.tenants.getByHandle)({ handle: key })
    .then((tenant) => {
      if (tenant) rememberHandleTenant(key, tenant);
      else forgetHandleTenant(key);
      return tenant;
    })
    .finally(() => {
      handleInflight.delete(key);
    });
  if (!opts?.fresh) handleInflight.set(key, pending);
  return pending;
}

export const getTenantByConversation = (conversationId: string) =>
  q(api.tenants.getByConversation)({ conversationId });

export type BindInboundResult =
  | {
      ok: true;
      tenant: NonNullable<FunctionReturnType<typeof api.tenants.getByPhone>>;
      firstBind: boolean;
    }
  | { ok: false; reason: string };

export async function getTenantByTelegram(
  telegramUserId: string,
): Promise<TelegramTenant> {
  const key = telegramUserId.trim();
  const cached = telegramTenants.get(key);
  if (cached.hit) return cached.value;
  const existing = telegramInflight.get(key);
  if (existing) return existing;
  const pending = q(api.tenants.getByTelegram)({ telegramUserId: key })
    .then((tenant) => {
      if (tenant) rememberTelegramTenant(key, tenant);
      else forgetTelegramTenant(key);
      return tenant;
    })
    .finally(() => {
      telegramInflight.delete(key);
    });
  telegramInflight.set(key, pending);
  return pending;
}

export const touchLastChannel = (
  phoneE164: string,
  lastChannel: "imessage" | "telegram",
): Promise<void> =>
  m(api.tenants.touchLastChannel)({ phoneE164, lastChannel }).then(() => {});

export const mintTelegramBind = (
  phoneE164: string,
): Promise<
  | { ok: true; token: string; alreadyLinked: boolean }
  | { ok: false; reason: "unbound" }
> => m(api.tenants.mintTelegramBind)({ phoneE164 });

export type BindTelegramResult =
  | {
      ok: true;
      tenant: NonNullable<FunctionReturnType<typeof api.tenants.getByPhone>>;
      firstBind: boolean;
    }
  | {
      ok: false;
      reason:
        | "expired"
        | "unknown_token"
        | "unbound_phone"
        | "already_other_user"
        | "already_other_tenant";
    };

export async function bindTelegram(opts: {
  token: string;
  telegramUserId: string;
  telegramChatId: string;
  telegramUsername?: string;
}): Promise<BindTelegramResult> {
  const result = await m(api.tenants.bindTelegram)(opts);
  forgetTelegramTenant(opts.telegramUserId);
  if (result.ok) {
    rememberTelegramTenant(opts.telegramUserId, result.tenant);
    if (result.tenant.inkboxHandle) forgetHandleTenant(result.tenant.inkboxHandle);
  }
  return result;
}

export async function bindPhotonInbound(opts: {
  phoneE164: string;
  photonConversationId: string;
  photonUserId?: string;
  photonAssignedNumber?: string;
  handle?: string;
}): Promise<BindInboundResult> {
  const result = await m(api.tenants.bindPhotonInbound)(opts);
  if (!result.ok) return result;
  if (result.tenant.inkboxHandle) forgetHandleTenant(result.tenant.inkboxHandle);
  if (result.tenant.telegramUserId) {
    forgetTelegramTenant(result.tenant.telegramUserId);
  }
  const firstBind = result.firstBind === true;
  return { ok: true, tenant: result.tenant, firstBind };
}

export async function markPhotonNudgeSent(
  conversationId: string,
  now = Date.now(),
): Promise<boolean> {
  const result = await m(api.tenants.markPhotonNudgeSent)({ conversationId, now });
  return result.sent;
}

export async function bindInbound(
  handle: string,
  phoneE164: string,
  inkboxConversationId?: string,
): Promise<BindInboundResult> {
  const result = await m(api.tenants.bindInbound)({
    handle,
    phoneE164,
    inkboxConversationId,
  });
  forgetHandleTenant(handle);
  if (!result.ok) return result;
  rememberHandleTenant(handle, result.tenant);
  if (result.tenant.telegramUserId) {
    forgetTelegramTenant(result.tenant.telegramUserId);
  }
  const firstBind = (result as { firstBind?: unknown }).firstBind === true;
  return { ok: true, tenant: result.tenant, firstBind };
}

export type BindGroupResult =
  | {
      ok: true;
      ownerPhoneE164: string;
      inkboxHandle: string;
      firstGroup: boolean;
    }
  | { ok: false; reason: string };

export async function bindGroupInbound(args: {
  conversationId: string;
  senderPhone: string;
  participants: string[];
  handle?: string;
  ownerPhone?: string;
}): Promise<BindGroupResult> {
  const result = await m(api.groupChats.bindInbound)(args);
  if (!result.ok) return result;
  return {
    ok: true,
    ownerPhoneE164: result.ownerPhoneE164,
    inkboxHandle: result.inkboxHandle,
    firstGroup: result.firstGroup,
  };
}

export const getGroupByConversation = (conversationId: string) =>
  q(api.groupChats.getByConversation)({ conversationId });

export async function replyTenant(conversationId: string) {
  const group = await getGroupByConversation(conversationId).catch(() => null);
  if (group?.ownerPhoneE164) {
    return await getTenant(group.ownerPhoneE164).catch(() => null);
  }
  return await getTenantByConversation(conversationId).catch(() => null);
}

export const setBrowser = (
  phoneE164: string,
  patch: {
    browserSessionId?: string;
    browserLiveUrl?: string;
    browserRunId?: string;
    browserTask?: string;
    browserStatus?: string;
    browserStartedAt?: number;
    browserProfileId?: string;
    browserCookieDomains?: string[];
    browserProfileSyncedAt?: number;
  },
): Promise<void> =>
  m(api.tenants.setBrowser)({ phoneE164, ...patch }).then(() => {});

export const getTenantByEmail = (emailAddress: string) =>
  q(api.tenants.getByEmail)({ emailAddress });

export async function jobWakeRows(phoneE164: string): Promise<JobWakeRow[]> {
  return (await loadWakeContext(phoneE164)).jobs;
}

export const listOpenJobs = (
  phoneE164: string,
): Promise<FunctionReturnType<typeof api.jobs.listOpen>> =>
  q(api.jobs.listOpen)({ phoneE164 });

export async function openJob(
  phoneE164: string,
  goal: string,
  doneWhen: string,
) {
  const id = await m(api.jobs.open)({ phoneE164, goal, doneWhen });
  forgetWake(phoneE164);
  return id;
}

export async function waitJob(
  phoneE164: string,
  jobId: string,
  waitingFor: "human" | "email" | "browser",
  extra?: {
    note?: string;
    emailThreadId?: string;
    emailMessageId?: string;
  },
) {
  const result = await m(api.jobs.wait)({
    phoneE164,
    jobId: jobId as Id<"jobs">,
    waitingFor,
    ...extra,
  });
  forgetWake(phoneE164);
  return result;
}

export async function finishJob(
  phoneE164: string,
  jobId: string,
  outcome: string,
  failed?: boolean,
) {
  const result = await m(api.jobs.finish)({
    phoneE164,
    jobId: jobId as Id<"jobs">,
    outcome,
    failed,
  });
  forgetWake(phoneE164);
  return result;
}

export async function markNudged(phoneE164: string, jobId: string) {
  const result = await m(api.jobs.markNudged)({
    phoneE164,
    jobId: jobId as Id<"jobs">,
  });
  forgetWake(phoneE164);
  return result;
}

export const touchJobMail = (
  phoneE164: string,
  jobId: string,
  extra: { emailThreadId?: string; emailMessageId?: string },
) =>
  m(api.jobs.touchMail)({
    phoneE164,
    jobId: jobId as Id<"jobs">,
    ...extra,
  });

export const scheduleWakeup = (args: {
  tenantPhone: string;
  at: number;
  kind: "reminder" | "browser_poll" | "brief" | "watcher" | "job_check";
  payload: string;
  recurMinutes?: number;
  recurDailyHour?: number;
  tz?: string;
}): Promise<string> => m(api.wakeups.schedule)(args);

export const cancelWakeup = (
  tenantPhone: string,
  opts: {
    id?: string;
    kind?: "reminder" | "browser_poll" | "brief" | "watcher" | "job_check";
    payloadContains?: string;
  },
): Promise<number> =>
  m(api.wakeups.cancel)({
    tenantPhone,
    id: opts.id as Id<"wakeups"> | undefined,
    kind: opts.kind,
  });

export const createWatcher = (args: {
  tenantPhone: string;
  source: "gmail" | "calendar";
  triggerId: string;
  triggerSlug: string;
  about: string;
  filter?: string;
}): Promise<string> => m(api.watchers.create)(args);

export const listWatchers = (
  tenantPhone: string,
): Promise<FunctionReturnType<typeof api.watchers.listActive>> =>
  q(api.watchers.listActive)({ tenantPhone });

export const stopWatchers = (
  tenantPhone: string,
  id?: string,
): Promise<{ id: string; triggerId: string }[]> =>
  m(api.watchers.stop)({ tenantPhone, id: id as Id<"watchers"> | undefined });

export const setWakeupLastSeen = (
  tenantPhone: string,
  lastSeen: string,
): Promise<void> =>
  m(api.wakeups.setLastSeen)({ tenantPhone, kind: "watcher", lastSeen }).then(() => {});

export const countInboundMessage = (
  phoneE164: string,
): Promise<{
  decision: "allow" | "paywall" | "drop";
  payUrl?: string;
}> => m(api.tenants.countInboundMessage)({ phoneE164 });

export const markPaywallSent = (
  phoneE164: string,
): Promise<{ alreadySentToday: boolean }> =>
  m(api.tenants.markPaywallSent)({ phoneE164 });

export const countBrowserJobStart = (
  phoneE164: string,
): Promise<{ allowed: boolean }> =>
  m(api.tenants.countBrowserJobStart)({ phoneE164 });

/** Charges one browser job for a whole worker assignment, not per browser. */
export const startBrowserErrand = (args: {
  phoneE164: string;
  workerSessionId: string;
}): Promise<{ allowed: boolean }> => m(api.tenants.startBrowserErrand)(args);

export const startBrowserFollow = (args: {
  tenantPhone: string;
  runId: string;
  sessionId?: string;
  task: string;
  startedAt: number;
}): Promise<{ workflowId: string; reused: boolean } | { error: string }> =>
  m(api.browserFollow.startFollowThrough)(args);

export const cancelBrowserFollow = (
  tenantPhone: string,
  runId: string,
): Promise<{ cancelled: number; error?: string }> =>
  m(api.browserFollow.cancelFollowThrough)({ tenantPhone, runId });

export type VaultKindName = "login" | "payment" | "address" | "contact";

export const listVaultItems = (
  phoneE164: string,
): Promise<
  {
    handle: string;
    kind: VaultKindName;
    label: string;
    account: string;
    origin?: string;
    available: boolean;
  }[]
> => q(api.vault.listForAgent)({ phoneE164 });

export const readVaultSecret = (
  phoneE164: string,
  handle: string,
): Promise<{ kind: VaultKindName; origin?: string; secret: string } | null> =>
  a(api.vaultSecrets.readForAgent)({ phoneE164, handle });

export const registerBrowserSession = (args: {
  phoneE164: string;
  sessionId: string;
  workerSessionId?: string;
  saveChanges: boolean;
}): Promise<{ ok: true } | { ok: false; reason: "writer_busy"; sessionId: string }> =>
  m(api.browsers.register)(args);

export const dropBrowserSession = (
  phoneE164: string,
  sessionId: string,
): Promise<void> => m(api.browsers.drop)({ phoneE164, sessionId }).then(() => {});

export const getBrowserSession = (
  phoneE164: string,
  sessionId: string,
): Promise<{
  sessionId: string;
  workerSessionId?: string;
  saveChanges: boolean;
  createdAt: number;
} | null> => q(api.browsers.get)({ phoneE164, sessionId });

export const listBrowserSessionIds = (phoneE164: string): Promise<string[]> =>
  q(api.browsers.listIds)({ phoneE164 });

export type OrderMerchant = "wb" | "ozon" | "other";
export type OrderStatus = "placed" | "cancelled" | "unknown";

export type RecordOrderInput = {
  merchant: OrderMerchant;
  merchantOrderId: string;
  title: string;
  priceRub: number;
  status: OrderStatus;
  pickup?: string;
};

export async function recordOrder(
  phoneE164: string,
  row: RecordOrderInput,
): Promise<string> {
  const tenant = await getTenant(phoneE164);
  if (!tenant) throw new Error("unknown tenant");
  return await m(api.orders.record)({
    tenantId: tenant._id,
    merchant: row.merchant,
    merchantOrderId: row.merchantOrderId,
    title: row.title,
    priceRub: row.priceRub,
    status: row.status,
    ...(row.pickup ? { pickup: row.pickup } : {}),
  });
}

export async function listOrders(
  phoneE164: string,
): Promise<FunctionReturnType<typeof api.orders.listForPhone>> {
  return q(api.orders.listForPhone)({ phoneE164 });
}

export const chatgptStatus = (
  phoneE164: string,
): Promise<{
  status: "none" | "pending" | "connected" | "quarantined";
  email?: string;
  planType?: string;
}> => q(api.chatgpt.statusForAgent)({ phoneE164, now: Date.now() });

export const chatgptToken = (phoneE164: string): Promise<{
  status: "connected" | "none" | "quarantined";
  accessToken?: string;
  accountId?: string;
}> => a(api.chatgptSecrets.tokenForAgent)({ phoneE164 });

export const chatgptQuarantine = (
  phoneE164: string,
  reason: string,
): Promise<boolean> =>
  m(api.chatgpt.quarantineForAgent)({ phoneE164, now: Date.now(), reason });

export type StoredFile = {
  id: string;
  name: string;
  mimeType: string;
  size: number;
  createdAt: number;
  sourceChannel?: "imessage" | "telegram" | "sandbox" | "agent";
};

export type StoredFileWithUrl = StoredFile & { url: string | null };

export const listStoredFiles = (phoneE164: string): Promise<StoredFile[]> =>
  q(api.files.listForAgent)({ phoneE164 });

export const getStoredFile = (
  phoneE164: string,
  ref: { fileId?: string; name?: string },
): Promise<StoredFileWithUrl | null> =>
  q(api.files.getForAgent)({
    phoneE164,
    fileId: ref.fileId as Id<"files"> | undefined,
    name: ref.name,
  });

export const generateFileUploadUrl = (
  phoneE164: string,
): Promise<string | null> => m(api.files.generateUploadUrlForAgent)({ phoneE164 });

export const saveStoredFile = (
  phoneE164: string,
  args: {
    storageId: string;
    name: string;
    mimeType: string;
    size: number;
    sourceChannel?: StoredFile["sourceChannel"];
    now?: number;
  },
): Promise<StoredFile | null> =>
  m(api.files.saveForAgent)({
    phoneE164,
    storageId: args.storageId as Id<"_storage">,
    name: args.name,
    mimeType: args.mimeType,
    size: args.size,
    now: args.now ?? Date.now(),
    sourceChannel: args.sourceChannel,
  });

export const deleteStoredFile = (
  phoneE164: string,
  ref: { fileId?: string; name?: string },
): Promise<boolean> =>
  m(api.files.deleteForAgent)({
    phoneE164,
    fileId: ref.fileId as Id<"files"> | undefined,
    name: ref.name,
  });

export async function storeFileBytes(
  phoneE164: string,
  args: {
    name: string;
    mimeType: string;
    bytes: Uint8Array;
    sourceChannel?: StoredFile["sourceChannel"];
    now?: number;
  },
): Promise<StoredFile | null> {
  return await a(api.files.storeBytesForAgent)({
    phoneE164,
    name: args.name,
    mimeType: args.mimeType,
    bytesBase64: Buffer.from(args.bytes).toString("base64"),
    now: args.now ?? Date.now(),
    sourceChannel: args.sourceChannel,
  });
}

export async function updateOrderStatus(
  phoneE164: string,
  args: {
    status: OrderStatus;
    merchantOrderId?: string;
    orderId?: string;
  },
): Promise<FunctionReturnType<typeof api.orders.updateStatus>> {
  return m(api.orders.updateStatus)({
    phoneE164,
    status: args.status,
    merchantOrderId: args.merchantOrderId,
    orderId: args.orderId as Id<"orders"> | undefined,
  });
}

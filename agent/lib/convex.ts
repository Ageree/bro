import { ConvexHttpClient } from "convex/browser";
import type { FunctionReturnType } from "convex/server";
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

/** Same-turn reuse: webhook prefetch + memo, then jobs after Instinct searches. */
export const WAKE_CONTEXT_TTL_MS = 8_000;

function rememberWake(phoneE164: string, value: WakeContext): void {
  wakeCache.set(phoneE164, { at: Date.now(), value });
}

function forgetWake(phoneE164: string): void {
  wakeCache.delete(phoneE164);
}

/** One Convex snapshot for memo + jobs. Coalesces parallel and sequential turn.started callers. */
export async function loadWakeContext(phoneE164: string): Promise<WakeContext> {
  const cached = wakeCache.get(phoneE164);
  if (cached && Date.now() - cached.at < WAKE_CONTEXT_TTL_MS) return cached.value;
  const existing = wakeInflight.get(phoneE164);
  if (existing) return existing;
  const pending = client()
    .query(api.memories.wakeContext, {
      secret: secret(),
      phoneE164,
    })
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
  await client().mutation(api.memories.note, {
    secret: secret(),
    phoneE164,
    line,
  });
  forgetWake(phoneE164);
  return "noted";
}

export async function searchLines(
  phoneE164: string,
  needle: string,
): Promise<string[]> {
  return await client().query(api.memories.search, {
    secret: secret(),
    phoneE164,
    needle,
  });
}

export async function forgetLines(
  phoneE164: string,
  needle: string,
): Promise<string> {
  const n = await client().mutation(api.memories.forget, {
    secret: secret(),
    phoneE164,
    needle,
  });
  forgetWake(phoneE164);
  return `forgot ${n}`;
}

export async function upsertTenant(
  phoneE164: string,
  inkboxConversationId?: string,
  emailAddress?: string,
) {
  const tenant = await client().mutation(api.tenants.upsert, {
    secret: secret(),
    phoneE164,
    inkboxConversationId,
    emailAddress,
  });
  if (tenant.inkboxHandle) forgetHandleTenant(tenant.inkboxHandle);
  if (tenant.telegramUserId) forgetTelegramTenant(tenant.telegramUserId);
  return tenant;
}

export async function getTenant(phoneE164: string) {
  return await client().query(api.tenants.getByPhone, {
    secret: secret(),
    phoneE164,
  });
}

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

/** HMAC + skip-bind for returning 1:1. Process cache, same-turn coalesce. */
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
  const pending = client()
    .query(api.tenants.getByHandle, {
      secret: secret(),
      handle: key,
    })
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

export async function getTenantByConversation(conversationId: string) {
  return await client().query(api.tenants.getByConversation, {
    secret: secret(),
    conversationId,
  });
}

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
  const pending = client()
    .query(api.tenants.getByTelegram, {
      secret: secret(),
      telegramUserId: key,
    })
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

export async function touchLastChannel(
  phoneE164: string,
  lastChannel: "imessage" | "telegram",
): Promise<void> {
  await client().mutation(api.tenants.touchLastChannel, {
    secret: secret(),
    phoneE164,
    lastChannel,
  });
}

export async function mintTelegramBind(phoneE164: string): Promise<
  | { ok: true; token: string; alreadyLinked: boolean }
  | { ok: false; reason: "unbound" }
> {
  return await client().mutation(api.tenants.mintTelegramBind, {
    secret: secret(),
    phoneE164,
  });
}

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
  const result = await client().mutation(api.tenants.bindTelegram, {
    secret: secret(),
    ...opts,
  });
  forgetTelegramTenant(opts.telegramUserId);
  if (result.ok) {
    rememberTelegramTenant(opts.telegramUserId, result.tenant);
    if (result.tenant.inkboxHandle) forgetHandleTenant(result.tenant.inkboxHandle);
  }
  return result;
}

export async function bindInbound(
  handle: string,
  phoneE164: string,
  inkboxConversationId?: string,
): Promise<BindInboundResult> {
  const result = await client().mutation(api.tenants.bindInbound, {
    secret: secret(),
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
  const result = await client().mutation(api.groupChats.bindInbound, {
    secret: secret(),
    ...args,
  });
  if (!result.ok) return result;
  return {
    ok: true,
    ownerPhoneE164: result.ownerPhoneE164,
    inkboxHandle: result.inkboxHandle,
    firstGroup: result.firstGroup,
  };
}

export async function getGroupByConversation(conversationId: string) {
  return await client().query(api.groupChats.getByConversation, {
    secret: secret(),
    conversationId,
  });
}

export async function markGroupGreeted(conversationId: string): Promise<void> {
  await client().mutation(api.groupChats.markGreeted, {
    secret: secret(),
    conversationId,
  });
}

export async function replyTenant(conversationId: string) {
  const group = await getGroupByConversation(conversationId).catch(() => null);
  if (group?.ownerPhoneE164) {
    return await getTenant(group.ownerPhoneE164).catch(() => null);
  }
  return await getTenantByConversation(conversationId).catch(() => null);
}

export async function setBrowser(
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
): Promise<void> {
  await client().mutation(api.tenants.setBrowser, {
    secret: secret(),
    phoneE164,
    ...patch,
  });
}

export async function getTenantByEmail(emailAddress: string) {
  return await client().query(api.tenants.getByEmail, {
    secret: secret(),
    emailAddress,
  });
}

export async function jobWakeRows(phoneE164: string): Promise<JobWakeRow[]> {
  return (await loadWakeContext(phoneE164)).jobs;
}

export async function listOpenJobs(
  phoneE164: string,
): Promise<FunctionReturnType<typeof api.jobs.listOpen>> {
  return await client().query(api.jobs.listOpen, {
    secret: secret(),
    phoneE164,
  });
}

export async function openJob(
  phoneE164: string,
  goal: string,
  doneWhen: string,
) {
  const id = await client().mutation(api.jobs.open, {
    secret: secret(),
    phoneE164,
    goal,
    doneWhen,
  });
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
  const result = await client().mutation(api.jobs.wait, {
    secret: secret(),
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
  const result = await client().mutation(api.jobs.finish, {
    secret: secret(),
    phoneE164,
    jobId: jobId as Id<"jobs">,
    outcome,
    failed,
  });
  forgetWake(phoneE164);
  return result;
}

export async function markNudged(phoneE164: string, jobId: string) {
  const result = await client().mutation(api.jobs.markNudged, {
    secret: secret(),
    phoneE164,
    jobId: jobId as Id<"jobs">,
  });
  forgetWake(phoneE164);
  return result;
}

export async function touchJobMail(
  phoneE164: string,
  jobId: string,
  extra: { emailThreadId?: string; emailMessageId?: string },
) {
  return await client().mutation(api.jobs.touchMail, {
    secret: secret(),
    phoneE164,
    jobId: jobId as Id<"jobs">,
    ...extra,
  });
}

export async function scheduleWakeup(args: {
  tenantPhone: string;
  at: number;
  kind: "reminder" | "browser_poll" | "brief" | "watcher" | "job_check";
  payload: string;
  recurMinutes?: number;
  recurDailyHour?: number;
  tz?: string;
}): Promise<string> {
  return await client().mutation(api.wakeups.schedule, {
    secret: secret(),
    ...args,
  });
}

export async function cancelWakeup(
  tenantPhone: string,
  opts: {
    id?: string;
    kind?: "reminder" | "browser_poll" | "brief" | "watcher" | "job_check";
    payloadContains?: string;
  },
): Promise<number> {
  return await client().mutation(api.wakeups.cancel, {
    secret: secret(),
    tenantPhone,
    id: opts.id as Id<"wakeups"> | undefined,
    kind: opts.kind,
  });
}

export async function listWakeups(tenantPhone: string) {
  return await client().query(api.wakeups.listForTenant, {
    secret: secret(),
    tenantPhone,
  });
}

export async function createWatcher(args: {
  tenantPhone: string;
  source: "gmail" | "calendar";
  triggerId: string;
  triggerSlug: string;
  about: string;
  filter?: string;
}): Promise<string> {
  return await client().mutation(api.watchers.create, {
    secret: secret(),
    ...args,
  });
}

export async function listWatchers(
  tenantPhone: string,
): Promise<FunctionReturnType<typeof api.watchers.listActive>> {
  return await client().query(api.watchers.listActive, {
    secret: secret(),
    tenantPhone,
  });
}

export async function stopWatchers(
  tenantPhone: string,
  id?: string,
): Promise<{ id: string; triggerId: string }[]> {
  return await client().mutation(api.watchers.stop, {
    secret: secret(),
    tenantPhone,
    id: id as Id<"watchers"> | undefined,
  });
}

export async function setWakeupLastSeen(
  tenantPhone: string,
  lastSeen: string,
): Promise<void> {
  await client().mutation(api.wakeups.setLastSeen, {
    secret: secret(),
    tenantPhone,
    kind: "watcher",
    lastSeen,
  });
}

export async function countInboundMessage(phoneE164: string): Promise<{
  decision: "allow" | "paywall" | "drop";
  payUrl?: string;
}> {
  return await client().mutation(api.tenants.countInboundMessage, {
    secret: secret(),
    phoneE164,
  });
}

export async function markPaywallSent(
  phoneE164: string,
): Promise<{ alreadySentToday: boolean }> {
  return await client().mutation(api.tenants.markPaywallSent, {
    secret: secret(),
    phoneE164,
  });
}

export async function countBrowserJobStart(
  phoneE164: string,
): Promise<{ allowed: boolean }> {
  return await client().mutation(api.tenants.countBrowserJobStart, {
    secret: secret(),
    phoneE164,
  });
}

/** Charges one browser job for a whole worker assignment, not per browser. */
export async function startBrowserErrand(args: {
  phoneE164: string;
  workerSessionId: string;
}): Promise<{ allowed: boolean }> {
  return await client().mutation(api.tenants.startBrowserErrand, {
    secret: secret(),
    ...args,
  });
}

export async function startBrowserFollow(args: {
  tenantPhone: string;
  runId: string;
  sessionId?: string;
  task: string;
  startedAt: number;
}): Promise<{ workflowId: string; reused: boolean } | { error: string }> {
  return await client().mutation(api.browserFollow.startFollowThrough, {
    secret: secret(),
    ...args,
  });
}

export async function cancelBrowserFollow(
  tenantPhone: string,
  runId: string,
): Promise<{ cancelled: number; error?: string }> {
  return await client().mutation(api.browserFollow.cancelFollowThrough, {
    secret: secret(),
    tenantPhone,
    runId,
  });
}

export type VaultKindName = "login" | "payment" | "address" | "contact";

export async function listVaultItems(phoneE164: string): Promise<
  {
    handle: string;
    kind: VaultKindName;
    label: string;
    account: string;
    origin?: string;
    available: boolean;
  }[]
> {
  return await client().query(api.vault.listForAgent, {
    secret: secret(),
    phoneE164,
  });
}

export async function readVaultSecret(
  phoneE164: string,
  handle: string,
): Promise<{ kind: VaultKindName; origin?: string; secret: string } | null> {
  return await client().action(api.vaultSecrets.readForAgent, {
    secret: secret(),
    phoneE164,
    handle,
  });
}

export async function registerBrowserSession(args: {
  phoneE164: string;
  sessionId: string;
  workerSessionId?: string;
  saveChanges: boolean;
}): Promise<{ ok: true } | { ok: false; reason: "writer_busy"; sessionId: string }> {
  return await client().mutation(api.browsers.register, {
    secret: secret(),
    ...args,
  });
}

export async function dropBrowserSession(
  phoneE164: string,
  sessionId: string,
): Promise<void> {
  await client().mutation(api.browsers.drop, {
    secret: secret(),
    phoneE164,
    sessionId,
  });
}

export async function getBrowserSession(
  phoneE164: string,
  sessionId: string,
): Promise<{
  sessionId: string;
  workerSessionId?: string;
  saveChanges: boolean;
  createdAt: number;
} | null> {
  return await client().query(api.browsers.get, {
    secret: secret(),
    phoneE164,
    sessionId,
  });
}

export async function listBrowserSessionIds(phoneE164: string): Promise<string[]> {
  return await client().query(api.browsers.listIds, {
    secret: secret(),
    phoneE164,
  });
}

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
  return await client().mutation(api.orders.record, {
    secret: secret(),
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
  return await client().query(api.orders.listForPhone, {
    secret: secret(),
    phoneE164,
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
  return await client().mutation(api.orders.updateStatus, {
    secret: secret(),
    phoneE164,
    status: args.status,
    merchantOrderId: args.merchantOrderId,
    orderId: args.orderId as Id<"orders"> | undefined,
  });
}

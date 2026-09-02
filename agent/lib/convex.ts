import { ConvexHttpClient } from "convex/browser";
import type { FunctionReturnType } from "convex/server";
import { api } from "../../convex/_generated/api.js";
import type { Id } from "../../convex/_generated/dataModel";

function client(): ConvexHttpClient {
  const url = process.env.CONVEX_URL;
  if (!url) throw new Error("CONVEX_URL missing");
  return new ConvexHttpClient(url);
}

function secret(): string {
  const s = process.env.BRO_INTERNAL_SECRET;
  if (!s) throw new Error("BRO_INTERNAL_SECRET missing");
  return s;
}

export async function wakeLines(phoneE164: string): Promise<string[]> {
  return await client().query(api.memories.wake, {
    secret: secret(),
    phoneE164,
  });
}

export async function noteLine(phoneE164: string, line: string): Promise<string> {
  await client().mutation(api.memories.note, {
    secret: secret(),
    phoneE164,
    line,
  });
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
  return `forgot ${n}`;
}

export async function upsertTenant(
  phoneE164: string,
  inkboxConversationId?: string,
  emailAddress?: string,
) {
  return await client().mutation(api.tenants.upsert, {
    secret: secret(),
    phoneE164,
    inkboxConversationId,
    emailAddress,
  });
}

export async function getTenant(phoneE164: string) {
  return await client().query(api.tenants.getByPhone, {
    secret: secret(),
    phoneE164,
  });
}

export async function getTenantByHandle(handle: string) {
  return await client().query(api.tenants.getByHandle, {
    secret: secret(),
    handle,
  });
}

export async function getTenantByConversation(conversationId: string) {
  return await client().query(api.tenants.getByConversation, {
    secret: secret(),
    conversationId,
  });
}

export async function bindInbound(
  handle: string,
  phoneE164: string,
  inkboxConversationId?: string,
) {
  return await client().mutation(api.tenants.bindInbound, {
    secret: secret(),
    handle,
    phoneE164,
    inkboxConversationId,
  });
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

export async function jobWakeLines(phoneE164: string): Promise<string[]> {
  return await client().query(api.jobs.wake, {
    secret: secret(),
    phoneE164,
  });
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
  return await client().mutation(api.jobs.open, {
    secret: secret(),
    phoneE164,
    goal,
    doneWhen,
  });
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
  return await client().mutation(api.jobs.wait, {
    secret: secret(),
    phoneE164,
    jobId: jobId as Id<"jobs">,
    waitingFor,
    ...extra,
  });
}

export async function finishJob(
  phoneE164: string,
  jobId: string,
  outcome: string,
  failed?: boolean,
) {
  return await client().mutation(api.jobs.finish, {
    secret: secret(),
    phoneE164,
    jobId: jobId as Id<"jobs">,
    outcome,
    failed,
  });
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

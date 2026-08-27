import { ConvexHttpClient } from "convex/browser";
import { anyApi } from "convex/server";
import { api } from "../../convex/_generated/api";
import type { Id } from "../../convex/_generated/dataModel";

// ponytail: anyApi до codegen; после convex deploy можно вернуть typed api
const wakeups = anyApi.wakeups;

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

export async function setTimezone(phoneE164: string, tz: string): Promise<void> {
  await client().mutation(api.tenants.setTimezone, {
    secret: secret(),
    phoneE164,
    tz,
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

export async function listOpenJobs(phoneE164: string) {
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
  kind: "reminder" | "browser_poll" | "brief" | "watcher";
  payload: string;
  recurMinutes?: number;
  recurDailyHour?: number;
  tz?: string;
}): Promise<string> {
  return await client().mutation(wakeups.schedule, {
    secret: secret(),
    ...args,
  });
}

export async function cancelWakeup(
  tenantPhone: string,
  opts: {
    id?: string;
    kind?: "reminder" | "browser_poll" | "brief" | "watcher";
  },
): Promise<number> {
  return await client().mutation(wakeups.cancel, {
    secret: secret(),
    tenantPhone,
    ...opts,
  });
}

export async function listWakeups(tenantPhone: string) {
  return await client().query(wakeups.listForTenant, {
    secret: secret(),
    tenantPhone,
  });
}

export async function setWakeupLastSeen(
  tenantPhone: string,
  lastSeen: string,
): Promise<void> {
  await client().mutation(wakeups.setLastSeen, {
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

export async function countBrowserJobStart(
  phoneE164: string,
): Promise<{ allowed: boolean }> {
  return await client().mutation(api.tenants.countBrowserJobStart, {
    secret: secret(),
    phoneE164,
  });
}

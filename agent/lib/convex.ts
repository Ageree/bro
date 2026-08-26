import { ConvexHttpClient } from "convex/browser";
import { api } from "../../convex/_generated/api";

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
) {
  return await client().mutation(api.tenants.upsert, {
    secret: secret(),
    phoneE164,
    inkboxConversationId,
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
  },
): Promise<void> {
  await client().mutation(api.tenants.setBrowser, {
    secret: secret(),
    phoneE164,
    ...patch,
  });
}

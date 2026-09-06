import { MessageDirection } from "@inkbox/sdk";
import { inkbox } from "./inkbox";
import {
  extractOtpCodes,
  looksLikeOtpMail,
  OTP_BODY_CHARS,
  OTP_FETCH_BODY_CAP,
} from "./otp-policy.ts";

export type InboxSnap = {
  id: string;
  threadId?: string;
  from: string;
  subject: string;
  snippet: string;
  body?: string;
  createdAtMs?: number;
};

function createdMs(v: Date | string | undefined | null): number | undefined {
  if (!v) return undefined;
  const n = v instanceof Date ? v.getTime() : Date.parse(v);
  return Number.isFinite(n) ? n : undefined;
}

function asSnap(msg: {
  id: string;
  threadId?: string | null;
  fromAddress: string;
  subject: string | null;
  snippet: string | null;
  createdAt: Date;
}): InboxSnap {
  return {
    id: msg.id,
    threadId: msg.threadId ?? undefined,
    from: msg.fromAddress,
    subject: msg.subject ?? "",
    snippet: msg.snippet ?? "",
    createdAtMs: createdMs(msg.createdAt),
  };
}

/** Recent inbound on Bro's Inkbox mailbox. Newest first. Does not mark read. */
export async function listBroInbox(opts: {
  handle: string;
  sinceMs?: number;
  limit?: number;
}): Promise<InboxSnap[]> {
  const identity = await inkbox().getIdentity(opts.handle);
  const limit = Math.min(Math.max(opts.limit ?? 8, 1), 20);
  const since = opts.sinceMs;
  const startDatetime = since ? new Date(since).toISOString() : undefined;
  const out: InboxSnap[] = [];
  for await (const msg of identity.iterEmails({
    direction: MessageDirection.INBOUND,
    pageSize: Math.min(Math.max(limit, 8), 50),
    ...(startDatetime ? { startDatetime } : {}),
  })) {
    const at = createdMs(msg.createdAt);
    if (since != null && at != null && at < since) break;
    out.push(asSnap(msg));
    if (out.length >= limit) break;
  }
  return out;
}

/**
 * Fetch full body only for OTP-looking mail whose snippet has no code.
 * getMessage marks inbound read — keep the cap small.
 */
export async function fillOtpBodies(
  handle: string,
  snaps: readonly InboxSnap[],
  cap = OTP_FETCH_BODY_CAP,
): Promise<InboxSnap[]> {
  const identity = await inkbox().getIdentity(handle);
  let fetched = 0;
  const next = snaps.map((s) => ({ ...s }));
  for (let i = 0; i < next.length; i++) {
    const m = next[i]!;
    const hay = `${m.subject}\n${m.snippet}`;
    if (!looksLikeOtpMail({ from: m.from, subject: m.subject, body: m.snippet })) {
      continue;
    }
    if (extractOtpCodes(hay).length > 0) continue;
    if (fetched >= cap) break;
    try {
      const detail = await identity.getMessage(m.id);
      next[i] = {
        ...m,
        body: (detail.bodyText ?? m.snippet).slice(0, OTP_BODY_CHARS),
      };
      fetched++;
    } catch (err) {
      console.error("otp getMessage failed", m.id, err);
    }
  }
  return next;
}

export async function searchBroInbox(opts: {
  emailAddress: string;
  query: string;
  limit?: number;
}): Promise<InboxSnap[]> {
  const hits = await inkbox().mailboxes.search(opts.emailAddress, {
    q: opts.query,
    limit: Math.min(Math.max(opts.limit ?? 8, 1), 20),
  });
  return hits.map(asSnap);
}

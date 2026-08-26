const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const BODY_CAP = 2000;

export function normalizeEmail(raw: string): string {
  return raw.trim().toLowerCase();
}

export function isEmailAddr(raw: string): boolean {
  const e = normalizeEmail(raw);
  return e.length > 2 && e.length < 200 && EMAIL_RE.test(e);
}

export function mailWebhookUrl(imessageBase: string, handle?: string): string {
  const u = new URL(imessageBase);
  u.pathname = u.pathname.replace(/\/webhooks\/imessage\/?$/, "/webhooks/mail");
  if (!u.pathname.endsWith("/webhooks/mail")) u.pathname = "/webhooks/mail";
  if (handle) u.searchParams.set("h", handle);
  return u.toString();
}

export type JobSnap = {
  id: string;
  status: string;
  waitingFor?: string;
  emailThreadId?: string;
};

/** Pick the waiting-on-email job this inbound belongs to, or null. */
export function attachMailToJob(
  jobs: JobSnap[],
  threadId: string | null,
): string | null {
  const waiting = jobs.filter(
    (j) => j.status === "waiting" && j.waitingFor === "email",
  );
  if (threadId) {
    const hit = waiting.find((j) => j.emailThreadId === threadId);
    if (hit) return hit.id;
  }
  if (waiting.length === 1) return waiting[0]!.id;
  return null;
}

export function mailBelongsToTenant(
  tenantEmail: string | undefined,
  mailboxEmail: string | null | undefined,
  to: string[],
  cc: string[] | null | undefined,
): boolean {
  if (!tenantEmail) return false;
  const mine = normalizeEmail(tenantEmail);
  if (mailboxEmail && normalizeEmail(mailboxEmail) === mine) return true;
  for (const a of to) {
    if (normalizeEmail(a) === mine) return true;
  }
  for (const a of cc ?? []) {
    if (normalizeEmail(a) === mine) return true;
  }
  return false;
}

export function formatMailWake(opts: {
  jobId: string | null;
  messageId: string;
  threadId: string | null;
  from: string;
  subject: string;
  body: string;
}): string {
  const body =
    opts.body.length > BODY_CAP
      ? opts.body.slice(0, BODY_CAP) + "…"
      : opts.body;
  return [
    "[event:mail]",
    `job: ${opts.jobId ?? "none"}`,
    `id: ${opts.messageId}`,
    `thread: ${opts.threadId ?? "none"}`,
    `from: ${opts.from}`,
    `subject: ${opts.subject}`,
    "body:",
    body,
  ].join("\n");
}

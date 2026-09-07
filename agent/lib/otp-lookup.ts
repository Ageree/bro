import { searchArchive } from "./archive.ts";
import { fillOtpBodies, listBroInbox, searchBroInbox } from "./bro-inbox.ts";
import { agentHandle, inkbox } from "./inkbox";
import {
  archiveOtpAllowed,
  candidatesFromMail,
  formatOtpLookup,
  otpSearchQuery,
  pickOtp,
  senderFromArchiveContent,
  type OtpCandidate,
  type OtpLookupResult,
} from "./otp-policy.ts";

function mergeSnaps(
  listed: Awaited<ReturnType<typeof listBroInbox>>,
  extra: Awaited<ReturnType<typeof searchBroInbox>>,
): typeof listed {
  const seen = new Set(listed.map((m) => m.id));
  const out = [...listed];
  for (const m of extra) {
    if (seen.has(m.id)) continue;
    seen.add(m.id);
    out.push(m);
  }
  return out;
}

export async function findFreshOtp(opts: {
  phone: string;
  handle?: string;
  hint?: string;
  sinceMinutes?: number;
  nowMs?: number;
}): Promise<OtpLookupResult> {
  const now = opts.nowMs ?? Date.now();
  const windowMs = (opts.sinceMinutes ?? 15) * 60_000;
  const sinceMs = now - windowMs;
  const handle = opts.handle ?? agentHandle();
  const hint = opts.hint?.trim();

  let listed = await listBroInbox({
    handle,
    sinceMs,
    limit: 12,
  });

  if (hint) {
    try {
      const identity = await inkbox().getIdentity(handle);
      if (identity.emailAddress) {
        const extra = await searchBroInbox({
          emailAddress: identity.emailAddress,
          query: hint,
          limit: 6,
        });
        listed = mergeSnaps(listed, extra);
      }
    } catch (err) {
      console.error("otp mailbox search failed", err);
    }
  }

  listed = await fillOtpBodies(handle, listed);

  const mailHits: OtpCandidate[] = listed.flatMap((m) =>
    candidatesFromMail("bro_mail", {
      from: m.from,
      subject: m.subject,
      body: m.body ?? m.snippet,
      atMs: m.createdAtMs,
    }),
  );

  let archiveHits: OtpCandidate[] = [];
  if (process.env.SUPERMEMORY_API_KEY?.trim()) {
    try {
      const docs = await searchArchive(opts.phone, otpSearchQuery(hint), 6);
      archiveHits = docs
        .filter((d) => archiveOtpAllowed(d))
        .flatMap((d) =>
          candidatesFromMail("archive", {
            from: senderFromArchiveContent(d.content) ?? d.app,
            subject: d.title,
            body: d.content,
            atMs: d.date ? Date.parse(d.date) : undefined,
          }),
        );
    } catch (err) {
      console.error("otp archive search failed", err);
    }
  }

  return {
    ...formatOtpLookup(pickOtp([...mailHits, ...archiveHits], now)),
    messages: listed.length,
  };
}

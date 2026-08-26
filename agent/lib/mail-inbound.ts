import type { MailWebhookMessage, MailWebhookPayload } from "@inkbox/sdk";
import {
  attachMailToJob,
  formatMailWake,
  mailBelongsToTenant,
} from "../../convex/lib/mailPolicy.ts";
import {
  agentHandle,
  inkbox,
  isAccessHandle,
  webhookOk,
} from "./inkbox";
import {
  getTenant,
  getTenantByEmail,
  getTenantByHandle,
  listOpenJobs,
  touchJobMail,
} from "./convex";

function handleFromRequest(request: Request): string | undefined {
  try {
    const h = new URL(request.url).searchParams.get("h");
    if (h && isAccessHandle(h)) return h;
  } catch {
    return undefined;
  }
  return undefined;
}

export type MailIngest =
  | {
      conversationId: string;
      phone: string;
      handle: string;
      text: string;
    }
  | { drop: string; status?: number };

async function composeWake(
  phone: string,
  conversationId: string,
  handle: string,
  msg: MailWebhookMessage,
): Promise<MailIngest> {
  const jobs = await listOpenJobs(phone).catch((err) => {
    console.error("listOpenJobs failed", err);
    return [];
  });
  const jobId = attachMailToJob(
    jobs.map((j) => ({
      id: j._id,
      status: j.status,
      waitingFor: j.waitingFor,
      emailThreadId: j.emailThreadId,
    })),
    msg.thread_id,
  );
  if (jobId) {
    await touchJobMail(phone, jobId, {
      emailThreadId: msg.thread_id ?? undefined,
      emailMessageId: msg.id,
    }).catch((err) => console.error("touch job mail failed", err));
  }
  return {
    conversationId,
    phone,
    handle,
    text: formatMailWake({
      jobId,
      messageId: msg.id,
      threadId: msg.thread_id,
      from: msg.from_address,
      subject: msg.subject ?? "",
      body: (msg.body ?? msg.snippet ?? "").trim(),
    }),
  };
}

export async function ingestInboundMail(request: Request): Promise<MailIngest> {
  const handle = handleFromRequest(request);
  const hinted = handle
    ? await getTenantByHandle(handle).catch((err) => {
        console.error("getTenantByHandle failed", err);
        return null;
      })
    : null;
  const secret =
    hinted?.webhookSigningKey || process.env.INKBOX_WEBHOOK_SECRET;
  if (!secret) return { drop: "missing secret", status: 500 };

  const payload = Buffer.from(await request.arrayBuffer());
  if (!webhookOk(payload, request.headers, secret)) {
    return { drop: "unauthorized", status: 401 };
  }

  const body = JSON.parse(payload.toString()) as MailWebhookPayload;
  if (body.event_type !== "message.received") return { drop: "ignored event" };

  const msg = body.data.message;
  if (!msg || msg.direction !== "inbound") return { drop: "not inbound" };

  const mailboxEmail = msg.email_address ?? null;
  let tenant = hinted;
  if (!tenant && mailboxEmail) {
    tenant = await getTenantByEmail(mailboxEmail).catch((err) => {
      console.error("getTenantByEmail failed", err);
      return null;
    });
  }
  if (!tenant) {
    try {
      const identity = await inkbox().getIdentity(agentHandle());
      if (
        mailBelongsToTenant(
          identity.emailAddress ?? undefined,
          mailboxEmail,
          msg.to_addresses ?? [],
          msg.cc_addresses,
        )
      ) {
        const phone = process.env.ALLOWED_SENDERS?.split(",")[0]?.trim();
        if (phone) {
          tenant = await getTenant(phone).catch((err) => {
            console.error("getTenant failed", err);
            return null;
          });
        }
      }
    } catch (err) {
      console.error("founder mailbox lookup failed", err);
    }
  }

  if (tenant) {
    if (tenant.status === "disabled") return { drop: "disabled" };
    if (
      !mailBelongsToTenant(
        tenant.emailAddress,
        mailboxEmail,
        msg.to_addresses ?? [],
        msg.cc_addresses,
      ) &&
      tenant.emailAddress
    ) {
      return { drop: "foreign mailbox" };
    }
    const phone = tenant.phoneE164;
    const conversationId = tenant.inkboxConversationId;
    if (!phone || !conversationId) return { drop: "unbound tenant" };
    return composeWake(
      phone,
      conversationId,
      tenant.inkboxHandle ?? handle ?? agentHandle(),
      msg,
    );
  }

  // ponytail: Convex may be down; founder mailbox still maps to the
  // allowlisted iMessage thread via Inkbox. Drop this once emailAddress
  // lives on the founder tenant and Convex is paid.
  try {
    const identity = await inkbox().getIdentity(agentHandle());
    if (
      !mailBelongsToTenant(
        identity.emailAddress ?? undefined,
        mailboxEmail,
        msg.to_addresses ?? [],
        msg.cc_addresses,
      )
    ) {
      return { drop: "unknown mailbox" };
    }
    const phone = process.env.ALLOWED_SENDERS?.split(",")[0]?.trim();
    if (!phone) return { drop: "unknown mailbox" };
    const convos = await identity.listIMessageConversations({
      limit: 20,
      includeGroups: false,
    });
    const hit = convos.find((c) => c.remoteNumber === phone);
    if (!hit) return { drop: "unbound tenant" };
    console.log("mail inbound founder inkbox fallback");
    return composeWake(phone, hit.id, identity.agentHandle, msg);
  } catch (err) {
    console.error("founder inkbox fallback failed", err);
    return { drop: "unknown mailbox" };
  }
}

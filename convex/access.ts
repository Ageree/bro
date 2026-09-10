import { v } from "convex/values";
import { internalAction } from "./_generated/server";
import { internal } from "./_generated/api";
import {
  identityCap,
  identityCapReached,
  isIosUserAgent,
  isValidHandle,
  makeHandle,
} from "./lib/accessPolicy";
import { identityCreateBody } from "./lib/dedicatedLinePolicy";
import { mailWebhookUrl } from "./lib/mailPolicy";
import { newSessionToken, sha256hex } from "./lib/cabinetPolicy";
import { normalizePhotonE164, photonSmsLink } from "./lib/photonPolicy";
import { upsertPhotonSharedUser } from "./lib/photonRest";

type InkboxIdentity = {
  id?: string;
  agent_handle?: string;
  email_address?: string | null;
  mailbox?: { id?: string } | null;
  imessage_number?: {
    id?: string;
    number?: string;
    type?: string;
  } | null;
};

type InkboxSub = {
  signing_key?: string | null;
};

function apiKey(): string {
  const k = process.env.INKBOX_API_KEY;
  if (!k) throw new Error("INKBOX_API_KEY missing");
  return k;
}

function webhookBase(): string {
  const u = process.env.INKBOX_WEBHOOK_URL;
  if (!u) throw new Error("INKBOX_WEBHOOK_URL missing");
  return u;
}

function cap(): number {
  return identityCap(process.env.BRO_IDENTITY_CAP);
}

async function inkbox(
  method: string,
  path: string,
  body?: unknown,
): Promise<Record<string, unknown>> {
  const res = await fetch(`https://inkbox.ai/api/v1${path}`, {
    method,
    headers: {
      "X-API-Key": apiKey(),
      Accept: "application/json",
      ...(body ? { "Content-Type": "application/json" } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(20_000),
  });
  const text = await res.text();
  let json: Record<string, unknown> = {};
  try {
    json = text ? (JSON.parse(text) as Record<string, unknown>) : {};
  } catch {
    json = { raw: text.slice(0, 400) };
  }
  if (!res.ok) {
    const err = new Error(`inkbox ${res.status} ${path}: ${text.slice(0, 400)}`);
    (err as Error & { status: number }).status = res.status;
    throw err;
  }
  return json;
}

const result = v.union(
  v.object({
    ok: v.literal(true),
    handle: v.string(),
    smsLink: v.string(),
    connectCommand: v.string(),
    sessionToken: v.optional(v.string()),
  }),
  v.object({
    ok: v.literal(false),
    code: v.union(
      v.literal("not_ios"),
      v.literal("closed"),
      v.literal("need_phone"),
      v.literal("error"),
    ),
    message: v.string(),
  }),
);

export const requestAccess = internalAction({
  args: {
    handle: v.optional(v.string()),
    phone: v.optional(v.string()),
    ua: v.string(),
    create: v.boolean(),
  },
  returns: result,
  handler: async (ctx, { handle, phone, ua, create }) => {
    const phoneE164 = phone ? normalizePhotonE164(phone) : undefined;

    async function photonLinkFor(
      existingPhone: string,
    ): Promise<{ smsLink: string; connectCommand: string; userId: string; assigned: string }> {
      const user = await upsertPhotonSharedUser({
        phoneNumber: existingPhone,
        firstName: "Bro",
      });
      const assigned = user.assignedPhoneNumber?.trim();
      if (!assigned) throw new Error("photon user missing assigned number");
      return {
        smsLink: photonSmsLink(assigned),
        connectCommand: assigned,
        userId: user.id,
        assigned,
      };
    }

    if (handle && isValidHandle(handle)) {
      const existing = await ctx.runQuery(internal.tenants.getByHandleInternal, {
        handle,
      });
      if (existing?.inkboxIdentityId) {
        const knownPhone = existing.phoneE164 ?? phoneE164;
        if (!knownPhone) {
          return {
            ok: false as const,
            code: "need_phone" as const,
            message: "Нужен номер телефона, чтобы открыть чат Bro",
          };
        }
        try {
          const link = await photonLinkFor(knownPhone);
          await ctx.runMutation(internal.tenants.insertProvisioned, {
            inkboxHandle: handle,
            inkboxIdentityId: existing.inkboxIdentityId,
            phoneE164: knownPhone,
            photonUserId: link.userId,
            photonAssignedNumber: link.assigned,
          });
          return {
            ok: true as const,
            handle,
            smsLink: link.smsLink,
            connectCommand: link.connectCommand,
          };
        } catch (err) {
          return {
            ok: false as const,
            code: "error" as const,
            message: err instanceof Error ? err.message : "photon user failed",
          };
        }
      }
    }

    if (!create) {
      return {
        ok: false as const,
        code: "error" as const,
        message: "unknown handle",
      };
    }

    if (!isIosUserAgent(ua)) {
      return {
        ok: false as const,
        code: "not_ios" as const,
        message: "Открой эту страницу на iPhone",
      };
    }

    if (!phoneE164) {
      return {
        ok: false as const,
        code: "need_phone" as const,
        message: "Нужен номер телефона, чтобы открыть чат Bro",
      };
    }

    const used = await ctx.runQuery(internal.tenants.countProvisioned, {});
    if (identityCapReached(used, cap())) {
      return {
        ok: false as const,
        code: "closed" as const,
        message: "Пока закрыто",
      };
    }

    let lastErr = "create failed";
    for (let attempt = 0; attempt < 3; attempt++) {
      const candidate = makeHandle();
      let identity: InkboxIdentity;
      try {
        identity = (await inkbox("POST", "/identities", identityCreateBody({
          handle: candidate,
          displayName: "Bro",
          dedicatedLine: false,
        }))) as InkboxIdentity;
      } catch (err) {
        const status = (err as Error & { status?: number }).status;
        if (status === 402) {
          return {
            ok: false as const,
            code: "closed" as const,
            message: "Пока закрыто",
          };
        }
        if (status === 409) {
          lastErr = "handle taken";
          continue;
        }
        return {
          ok: false as const,
          code: "error" as const,
          message: err instanceof Error ? err.message : "identity failed",
        };
      }

      const id = identity.id;
      const gotHandle = identity.agent_handle ?? candidate;
      if (!id) {
        return {
          ok: false as const,
          code: "error" as const,
          message: "identity missing id",
        };
      }

      let mailboxId = identity.mailbox?.id;
      if (!mailboxId) {
        try {
          const full = (await inkbox("GET", `/identities/${gotHandle}`)) as InkboxIdentity;
          mailboxId = full.mailbox?.id;
          if (!identity.email_address && full.email_address) {
            identity.email_address = full.email_address;
          }
        } catch (err) {
          console.error("identity refetch failed", err);
        }
      }
      let signingKey: string | undefined;
      if (mailboxId) {
        try {
          const sub = (await inkbox("POST", "/webhooks/subscriptions", {
            mailbox_id: mailboxId,
            url: mailWebhookUrl(webhookBase(), gotHandle),
            event_types: ["message.received"],
          })) as InkboxSub;
          if (typeof sub.signing_key === "string" && sub.signing_key) {
            signingKey = sub.signing_key;
          }
        } catch (err) {
          console.error("mail webhook failed", err);
        }
      }

      let link: Awaited<ReturnType<typeof photonLinkFor>>;
      try {
        link = await photonLinkFor(phoneE164);
      } catch (err) {
        return {
          ok: false as const,
          code: "error" as const,
          message: err instanceof Error ? err.message : "photon user failed",
        };
      }

      await ctx.runMutation(internal.tenants.insertProvisioned, {
        inkboxHandle: gotHandle,
        inkboxIdentityId: id,
        emailAddress: identity.email_address ?? undefined,
        webhookSigningKey: signingKey,
        phoneE164,
        photonUserId: link.userId,
        photonAssignedNumber: link.assigned,
      });

      const sessionToken = newSessionToken();
      await ctx.runMutation(internal.cabinet.issueDeviceSession, {
        handle: gotHandle,
        tokenHash: await sha256hex(sessionToken),
        now: Date.now(),
      });
      return {
        ok: true as const,
        handle: gotHandle,
        smsLink: link.smsLink,
        connectCommand: link.connectCommand,
        sessionToken,
      };
    }

    return { ok: false as const, code: "error" as const, message: lastErr };
  },
});

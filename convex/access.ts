import { v } from "convex/values";
import { internalAction } from "./_generated/server";
import { internal } from "./_generated/api";
import {
  identityCapReached,
  isIosUserAgent,
  isValidHandle,
  makeHandle,
  webhookUrlForHandle,
} from "./lib/accessPolicy";
import {
  dedicatedLineEnabled,
  dedicatedLineFromIdentityPayload,
  identityCreateBody,
} from "./lib/dedicatedLinePolicy";
import { mailWebhookUrl } from "./lib/mailPolicy";

const DEFAULT_CAP = 10;

type InkboxIdentity = {
  id?: string;
  agent_handle?: string;
  email_address?: string | null;
  mailbox?: { id?: string } | null;
  imessage_number?: {
    id?: string;
    number?: string;
    type?: string;
    status?: string;
  } | null;
};

type InkboxTriage = {
  number?: string;
  connect_command?: string;
  sms_link?: string;
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
  const n = Number(process.env.BRO_IDENTITY_CAP ?? DEFAULT_CAP);
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_CAP;
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

async function triage(identityId: string): Promise<InkboxTriage> {
  const q = new URLSearchParams({ agent_identity_id: identityId });
  return (await inkbox(
    "GET",
    `/imessage/triage-number?${q}`,
  )) as InkboxTriage;
}

const result = v.union(
  v.object({
    ok: v.literal(true),
    handle: v.string(),
    smsLink: v.string(),
    connectCommand: v.string(),
  }),
  v.object({
    ok: v.literal(false),
    code: v.union(
      v.literal("not_ios"),
      v.literal("closed"),
      v.literal("error"),
    ),
    message: v.string(),
  }),
);

export const requestAccess = internalAction({
  args: {
    handle: v.optional(v.string()),
    ua: v.string(),
    create: v.boolean(),
  },
  returns: result,
  handler: async (ctx, { handle, ua, create }) => {
    if (handle && isValidHandle(handle)) {
      const existing = await ctx.runQuery(internal.tenants.getByHandleInternal, {
        handle,
      });
      if (existing?.inkboxIdentityId) {
        try {
          const t = await triage(existing.inkboxIdentityId);
          if (t.sms_link && t.connect_command) {
            return {
              ok: true as const,
              handle,
              smsLink: t.sms_link,
              connectCommand: t.connect_command,
            };
          }
        } catch (err) {
          return {
            ok: false as const,
            code: "error" as const,
            message: err instanceof Error ? err.message : "triage failed",
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
          dedicatedLine: dedicatedLineEnabled(process.env.BRO_DEDICATED_LINE),
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

      let signingKey: string | undefined;
      try {
        const sub = (await inkbox("POST", "/webhooks/subscriptions", {
          agent_identity_id: id,
          url: webhookUrlForHandle(webhookBase(), gotHandle),
          event_types: ["imessage.received", "imessage.delivery_failed"],
        })) as InkboxSub;
        if (typeof sub.signing_key === "string" && sub.signing_key) {
          signingKey = sub.signing_key;
        }
      } catch (err) {
        return {
          ok: false as const,
          code: "error" as const,
          message: err instanceof Error ? err.message : "webhook failed",
        };
      }

      let mailboxId = identity.mailbox?.id;
      const wantDedicated = dedicatedLineEnabled(process.env.BRO_DEDICATED_LINE);
      if (!mailboxId || (wantDedicated && !identity.imessage_number)) {
        try {
          const full = (await inkbox("GET", `/identities/${gotHandle}`)) as InkboxIdentity;
          mailboxId = mailboxId ?? full.mailbox?.id;
          if (!identity.email_address && full.email_address) {
            identity.email_address = full.email_address;
          }
          if (!identity.imessage_number && full.imessage_number) {
            identity.imessage_number = full.imessage_number;
          }
        } catch (err) {
          console.error("identity refetch failed", err);
        }
      }
      if (mailboxId) {
        try {
          await inkbox("POST", "/webhooks/subscriptions", {
            mailbox_id: mailboxId,
            url: mailWebhookUrl(webhookBase(), gotHandle),
            event_types: ["message.received"],
          });
        } catch (err) {
          console.error("mail webhook failed", err);
        }
      }

      const dedicatedLine = dedicatedLineFromIdentityPayload(identity);
      await ctx.runMutation(internal.tenants.insertProvisioned, {
        inkboxHandle: gotHandle,
        inkboxIdentityId: id,
        emailAddress: identity.email_address ?? undefined,
        webhookSigningKey: signingKey,
        dedicatedIMessageNumber: dedicatedLine?.number,
        dedicatedIMessageNumberStatus: dedicatedLine?.status,
      });

      try {
        const t = await triage(id);
        if (!t.sms_link || !t.connect_command) {
          return {
            ok: false as const,
            code: "error" as const,
            message: "no sms_link",
          };
        }
        return {
          ok: true as const,
          handle: gotHandle,
          smsLink: t.sms_link,
          connectCommand: t.connect_command,
        };
      } catch (err) {
        return {
          ok: false as const,
          code: "error" as const,
          message: err instanceof Error ? err.message : "triage failed",
        };
      }
    }

    return { ok: false as const, code: "error" as const, message: lastErr };
  },
});

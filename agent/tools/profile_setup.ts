import { defineTool } from "eve/tools";
import { z } from "zod";
import { browserGateFromResult } from "../../convex/lib/billingPolicy";
import {
  loginChatText,
  loginPageUrl,
} from "../../convex/lib/browserProfilePolicy.ts";
import {
  createProfile,
  envSyncedProfileId,
  loginWaitTask,
  startRun,
  waitForLiveUrl,
} from "../lib/browseruse";
import { countBrowserJobStart, setBrowser, upsertTenant } from "../lib/convex";
import { sendBlueIMessage } from "../lib/inkbox";
import { tenantId } from "../lib/tenant";

function conversationId(
  ctx: {
    session: {
      auth: {
        current?: { attributes?: Record<string, unknown> } | null;
        initiator?: { attributes?: Record<string, unknown> } | null;
      };
    };
  },
  fallback?: string,
): string | undefined {
  const attrs =
    ctx.session.auth.current?.attributes ??
    ctx.session.auth.initiator?.attributes;
  const fromAuth = attrs?.conversationId;
  if (typeof fromAuth === "string" && fromAuth.length > 0) return fromAuth;
  return fallback;
}

export default defineTool({
  description:
    "Send the human a one-tap link to log into a website. They open it and sign in themselves; cookies save to their Cloud profile. Bro never sees the password. Call with the https page URL when a site needs login. Do not ask for a password and do not use vault_setup for site logins.",
  inputSchema: z.object({
    url: z.string().min(8).max(2000),
    site: z.string().min(1).max(80).optional(),
  }),
  async execute({ url, site }, ctx) {
    const page = loginPageUrl(url);
    if (!page) {
      return {
        status: "invalid",
        hint: "нужна обычная ссылка на сайт, например https://www.ozon.ru",
      };
    }

    const phone = tenantId(ctx);
    const tenant = await upsertTenant(phone);
    const conv = conversationId(ctx, tenant.inkboxConversationId);

    let allowed = false;
    try {
      allowed = browserGateFromResult(
        await countBrowserJobStart(phone),
        undefined,
      ).allowed;
    } catch (err) {
      console.error("billing browser count failed", err);
      allowed = browserGateFromResult(undefined, err).allowed;
    }
    if (!allowed) {
      return {
        status: "limit",
        hint: "скажи человеку, что лимит браузер-задач на месяц исчерпан, предложи оплату",
      };
    }

    let profileId = tenant.browserProfileId ?? envSyncedProfileId();
    if (!profileId) {
      try {
        profileId = await createProfile(phone);
      } catch (err) {
        console.error("browser profile create failed", err);
        return {
          status: "error",
          hint: "не получилось открыть вход, попробуй ещё раз",
        };
      }
    }

    const task = loginWaitTask(page);
    const started = await startRun(task, undefined, {
      profileId,
      profileSynced: false,
    });
    const withLive = await waitForLiveUrl(started);
    await setBrowser(phone, {
      browserRunId: withLive.runId,
      browserTask: task,
      browserStatus: withLive.status,
      browserStartedAt: Date.now(),
      browserProfileId: profileId,
      ...(withLive.sessionId ? { browserSessionId: withLive.sessionId } : {}),
      ...(withLive.liveUrl ? { browserLiveUrl: withLive.liveUrl } : {}),
    });

    if (!withLive.liveUrl) {
      return {
        status: "error",
        hint: "ссылка ещё не готова, вызови profile_setup ещё раз с тем же url",
      };
    }

    const text = loginChatText(withLive.liveUrl, site);
    if (conv) {
      try {
        await sendBlueIMessage({
          conversationId: conv,
          text,
          handle: tenant.inkboxHandle,
        });
      } catch (err) {
        console.error("login link notify failed", err);
        return {
          status: "ready",
          url: withLive.liveUrl,
          alreadyNotified: false,
          hint: "вставь человеку это сообщение как есть, второй копией ссылку не дублируй",
          message: text,
        };
      }
    }

    return {
      status: "ready",
      url: withLive.liveUrl,
      alreadyNotified: Boolean(conv),
      hint: conv
        ? "ссылка уже ушла в чат. Не дублируй. Когда человек напишет, что вошёл — продолжай browser_task."
        : "отправь человеку message как есть",
      message: text,
    };
  },
});

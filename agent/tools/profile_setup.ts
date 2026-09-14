import { defineTool } from "eve/tools";
import { z } from "zod";
import { browserGateFromResult } from "../../convex/lib/billingPolicy";
import { LOGIN_LANDING_WAIT_MS } from "../../convex/lib/browserLivePolicy.ts";
import {
  alreadyLoggedChatText,
  cookieDomainsCoverPage,
  loginChatText,
  loginOpeningText,
  loginPageUrl,
  loginVaultChatText,
  loginVaultTask,
} from "../../convex/lib/browserProfilePolicy.ts";
import {
  createProfile,
  envSyncedProfileId,
  getProfile,
  loginWaitTask,
  startRun,
  waitForLoginLanding,
  type BrowserRun,
} from "../lib/browseruse";
import {
  countBrowserJobStart,
  setBrowser,
  startBrowserFollow,
  upsertTenant,
} from "../lib/convex";
import { conversationId, groupPersonalBlock } from "../lib/group-guard";
import { tenantId } from "../lib/tenant";
import { attrsFromSession, channelFromAuth } from "../lib/deliver-routed";
import { deliverHuman } from "../lib/deliver-human";
import { markTurnSpoke, turnSpoke } from "../lib/early-deliver.ts";
import { vaultPasswordLogin } from "../lib/vault-login.ts";

const NO_PASSWORD_HINT =
  "Не проси логин или пароль в чат. Ссылка уйдёт сама или вызови profile_setup ещё раз с тем же url.";

type TenantRow = Awaited<ReturnType<typeof upsertTenant>>;

async function persistRun(
  phone: string,
  run: BrowserRun,
  task: string,
  extra?: {
    startedAt?: number;
    profileId?: string;
    loginLinkSentAt?: number;
  },
): Promise<void> {
  await setBrowser(phone, {
    browserRunId: run.runId,
    browserTask: task,
    browserStatus: run.status,
    ...(extra?.startedAt !== undefined ? { browserStartedAt: extra.startedAt } : {}),
    ...(extra?.profileId ? { browserProfileId: extra.profileId } : {}),
    ...(run.sessionId ? { browserSessionId: run.sessionId } : {}),
    ...(extra?.loginLinkSentAt !== undefined && run.liveUrl
      ? {
          browserLiveUrl: run.liveUrl,
          browserLoginLinkSentAt: extra.loginLinkSentAt,
        }
      : {}),
  });
}

async function kickFollow(opts: {
  phone: string;
  run: BrowserRun;
  task: string;
  startedAt: number;
}): Promise<void> {
  await startBrowserFollow({
    tenantPhone: opts.phone,
    runId: opts.run.runId,
    sessionId: opts.run.sessionId,
    task: opts.task,
    startedAt: opts.startedAt,
  }).catch((err) => {
    console.error("login follow workflow failed", err);
  });
}

async function notify(opts: {
  tenant: TenantRow;
  session: Parameters<typeof attrsFromSession>[0];
  conversationId: string | undefined;
  turnId: string | undefined;
  text: string;
  telegramText?: string;
}): Promise<boolean> {
  const conv = opts.conversationId;
  if (!conv) return false;
  const telegram =
    channelFromAuth(attrsFromSession(opts.session), opts.tenant.lastChannel) ===
    "telegram";
  await deliverHuman({
    tenant: opts.tenant,
    conversationId: conv,
    text: telegram && opts.telegramText ? opts.telegramText : opts.text,
    ...(telegram ? { channel: "telegram" as const } : {}),
  });
  if (opts.turnId) markTurnSpoke(opts.turnId, Date.now());
  return true;
}

export default defineTool({
  description:
    "Log into any site or save the account for later. If a matching vault login (kind login) exists, Bro types it via secretBindings and does not ask in chat. If not, Bro opens the site login page, announces that, then texts the live-view link only after that page is showing. Never ask for a login or password. Never offer the link as an option. Never put a site password in iMessage. Person adds or edits vault logins on brobro.tech (vault_setup kind=login). Pass the https login page URL.",
  inputSchema: z.object({
    url: z.string().min(8).max(2000),
    site: z.string().min(1).max(80).optional(),
  }),
  async execute({ url, site }, ctx) {
    const blocked = groupPersonalBlock(ctx);
    if (blocked) return { status: "group", hint: blocked };
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
    const turnId = typeof ctx.session.turn?.id === "string" ? ctx.session.turn.id : undefined;

    let profileId = tenant.browserProfileId ?? envSyncedProfileId();
    if (!profileId) {
      try {
        profileId = await createProfile(phone);
      } catch (err) {
        console.error("browser profile create failed", err);
        return {
          status: "error",
          hint: `не получилось открыть вход, вызови profile_setup ещё раз с тем же url. ${NO_PASSWORD_HINT}`,
        };
      }
    }

    let cookieDomains = tenant.browserCookieDomains ?? [];
    if (profileId && cookieDomains.length === 0) {
      try {
        cookieDomains = (await getProfile(profileId)).cookieDomains;
      } catch (err) {
        console.error("browser profile get failed", err);
      }
    }
    if (cookieDomains.length > 0) {
      await setBrowser(phone, {
        browserProfileId: profileId,
        browserCookieDomains: cookieDomains,
        browserProfileSyncedAt: Date.now(),
      });
    }
    if (cookieDomainsCoverPage(cookieDomains, page)) {
      await setBrowser(phone, {
        browserProfileId: profileId,
        browserCookieDomains: cookieDomains,
        browserProfileSyncedAt: Date.now(),
      });
      const text = alreadyLoggedChatText(site);
      let notified = false;
      try {
        notified = await notify({
          tenant,
          session: ctx.session,
          conversationId: conv,
          turnId,
          text,
        });
      } catch (err) {
        console.error("already-logged notify failed", err);
      }
      return {
        status: "already",
        usedProfile: true,
        alreadyNotified: notified,
        hint: "куки сайта есть — live-view не шли и пароль не проси. Сразу browser_task. Куки ≠ вход: если на экране Войти, Cloud должен войти.",
        message: text,
      };
    }

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

    const vault = await vaultPasswordLogin(phone, page);
    if (vault) {
      const vaultTask = loginVaultTask(page);
      let vaultRun: BrowserRun | undefined;
      try {
        vaultRun = await startRun(vaultTask, undefined, {
          profileId,
          profileSynced: false,
          login: true,
          secretBindings: vault.bindings,
        });
      } catch (err) {
        console.error("vault login run failed", err);
      }
      if (vaultRun) {
        const startedAt = Date.now();
        await persistRun(phone, vaultRun, vaultTask, { startedAt, profileId });
        const text = loginVaultChatText(site);
        let notified = false;
        try {
          notified = await notify({
            tenant,
            session: ctx.session,
            conversationId: conv,
            turnId,
            text,
          });
        } catch (err) {
          console.error("vault login notify failed", err);
        }
        await kickFollow({ phone, run: vaultRun, task: vaultTask, startedAt });
        return {
          status: "running",
          usedVault: true,
          alreadyNotified: notified,
          hint: notified
            ? "вход из сейфа уже идёт. Не проси пароль и не шли live-view ссылку. Когда человек напишет или job закончится — продолжай browser_task."
            : `скажи человеку message как есть. Не проси пароль. ${text}`,
          message: text,
        };
      }
    }

    const task = loginWaitTask(page);
    const started = await startRun(task, undefined, {
      profileId,
      profileSynced: false,
    });
    const startedAt = Date.now();
    await persistRun(phone, started, task, { startedAt, profileId });

    const opening = loginOpeningText(site);
    if (conv && !turnSpoke(turnId)) {
      await deliverHuman({
        tenant,
        conversationId: conv,
        text: opening,
      }).catch((err) => console.error("login opening notify failed", err));
      if (turnId) markTurnSpoke(turnId, Date.now());
    }

    const withLive = await waitForLoginLanding(
      started,
      page,
      LOGIN_LANDING_WAIT_MS,
    );
    const liveUrl = withLive.liveUrl;
    const landed = Boolean(liveUrl && withLive.landed);
    await persistRun(phone, withLive, task, {
      startedAt,
      profileId,
      ...(landed ? { loginLinkSentAt: Date.now() } : {}),
    });

    const followKick = kickFollow({ phone, run: withLive, task, startedAt });

    if (!liveUrl || !landed) {
      await followKick;
      return {
        status: "pending",
        alreadyNotified: Boolean(conv),
        hint: `ссылка уйдёт в чат, когда откроется страница входа. Подожди или вызови profile_setup ещё раз с тем же url. ${NO_PASSWORD_HINT}`,
        message: opening,
      };
    }

    const text = loginChatText(liveUrl, site);
    const where = site?.trim() ? ` в ${site.trim()}` : "";
    const telegramText = `Открой и войди${where}. Bro пароль не увидит — вход сохранится сам.\n\n:::buttons\n[Войти](${liveUrl})\n:::`;
    if (conv) {
      try {
        await notify({
          tenant,
          session: ctx.session,
          conversationId: conv,
          turnId,
          text,
          telegramText,
        });
      } catch (err) {
        console.error("login link notify failed", err);
        await setBrowser(phone, {
          browserRunId: withLive.runId,
          browserLoginLinkSentAt: undefined,
        });
        await followKick;
        return {
          status: "ready",
          url: liveUrl,
          alreadyNotified: false,
          hint: `вставь человеку message как есть. ${NO_PASSWORD_HINT}`,
          message: text,
        };
      }
    }

    await followKick;
    return {
      status: "ready",
      url: liveUrl,
      alreadyNotified: Boolean(conv),
      hint: conv
        ? `ссылка уже ушла в чат. Не дублируй и не проси пароль. Когда человек напишет, что вошёл — продолжай browser_task.`
        : `отправь человеку message как есть. ${NO_PASSWORD_HINT}`,
      message: text,
    };
  },
});

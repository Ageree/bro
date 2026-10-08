import { defineDynamic, defineTool, type ToolContext } from "eve/tools";
import { z } from "zod";
import { reportCardHold } from "@agent/lib/delivery/report-cards";
import { ownTurnApproval, resolveModeValue } from "@agent/lib/mode";
import { scopeFromPrincipal } from "@agent/lib/principal-scope";
import { disconnectMail, readMailConnection } from "@db/services/mail";
import { applicationOrigin } from "@shared/environment/origin";
import { mailEnabled, mailProviderConfigured } from "@shared/mail/providers";
import {
  mailAccessSchema,
  mailProviderNames,
  mailProviderSchema,
  type MailAccess,
  type MailProvider,
} from "@shared/mail/schema";

const inputSchema = z
  .object({
    provider: mailProviderSchema,
    action: z.enum(["status", "connect", "disconnect"]).default("connect"),
    access: mailAccessSchema
      .optional()
      .describe(
        "Omit to preserve the current level. Never request full access when the person chose read_only unless they explicitly ask to widen access."
      ),
  })
  .strict();

const abilities = {
  full: "Читать и искать письма, отправлять их, сохранять черновики, менять отметки и перемещать письма между входящими и архивом. Удаления писем нет.",
  read_only:
    "Только читать и искать письма. Бро не отправляет письма, не сохраняет черновики, не меняет отметки и не перемещает письма.",
};

function connectionAbilities(provider: MailProvider, access: MailAccess) {
  return provider === "mailru" && access === "read_only"
    ? `${abilities.read_only} У Mail.ru этот режим ограничивается на стороне Бро: сам провайдер выдаёт более широкий доступ mail.imap.`
    : abilities[access];
}

function connectionScope(context: Pick<ToolContext, "session">) {
  const caller = context.session.auth.current ?? context.session.auth.initiator;
  if (caller?.principalType !== "user") {
    throw new Error("Connecting mail needs an authenticated workspace user.");
  }
  const scope = scopeFromPrincipal(caller);
  if (!mailEnabled(scope)) {
    throw new Error("Mail is not enabled for this workspace.");
  }
  if (resolveModeValue(context, { interactive: true }) !== true) {
    throw new Error("Background workers cannot change mail connections.");
  }
  return scope;
}

export const connectMail = defineTool({
  approval: async (context) => {
    const held = await reportCardHold(context.session);
    if (held !== undefined) return { reason: held, type: "denied" as const };
    if (context.toolInput?.action === "disconnect") {
      return ownTurnApproval(context);
    }
    if (
      context.toolInput?.action === "status" ||
      context.toolInput?.access === undefined
    ) {
      return "not-applicable";
    }
    const connection = await readMailConnection(
      connectionScope(context),
      context.toolInput.provider
    );
    return context.toolInput.access !== connection.access
      ? ownTurnApproval(context)
      : "not-applicable";
  },
  description:
    "Check, connect or disconnect the person's Mail.ru or Yandex mail for this workspace; Gmail continues to use connect_google. Use action status when asked whether this mail is connected: it only reports the account, access and abilities, never creates a link or changes access. Action connect returns connected when the existing grant matches, otherwise authorize with a safe application URL: deliver url and notice with send_message as a link; the person must open it in a browser and sign in to the same Bro cabinet account before provider consent. previousConnectionRemoved means the old local grant was deleted and Bro has no access until consent finishes. Bro never asks the person to paste OAuth tokens or passwords and never receives them in tool results. Access read_only allows only search and reading; full also allows drafts, sending and reversible mailbox changes. Relay abilities, including Mail.ru's locally enforced read-only limitation. Omit access to keep the current level (full for a first connection). Never automatically upgrade read_only or suggest widening it; request full only if the person explicitly asks. Action disconnect removes Bro's locally stored grant only: it does not delete messages or revoke the provider's consent, which the person can revoke in the provider's settings. Relay the disconnect notice. Not_configured means this provider is unavailable on this deployment, never success. A connection link does not mean consent is complete. The person's own request to disconnect or change the level proceeds without a card; a turn Bro started itself needs their card.",
  inputSchema,
  async execute(input, context) {
    const held = await reportCardHold(context.session);
    if (held !== undefined) throw new Error(held);
    const scope = connectionScope(context);
    const name = mailProviderNames[input.provider];
    if (input.action === "disconnect") {
      await disconnectMail(scope, input.provider);
      return {
        provider: input.provider,
        status: "disconnected" as const,
        notice: `Бро больше не имеет локального доступа к ${name}: сохранённое подключение удалено. Письма и сам почтовый ящик не удалены. Разрешение у провайдера этим не отзывается — его можно отозвать в настройках ${name}. Ранее показанные письма могут остаться в истории разговора.`,
      };
    }

    const connection = await readMailConnection(scope, input.provider);
    if (
      !mailProviderConfigured(input.provider) ||
      connection.state === "unavailable"
    ) {
      return {
        provider: input.provider,
        status: "not_configured" as const,
        detail: `${name} на этом сервере не настроена или недоступна для этого workspace.`,
      };
    }
    if (input.action === "status") {
      if (connection.state !== "connected") {
        return {
          provider: input.provider,
          status: "not_connected" as const,
          access: connection.access,
          detail: `${name} не подключена.`,
        };
      }
      return {
        provider: input.provider,
        status: "connected" as const,
        email: connection.email,
        access: connection.access,
        abilities: connectionAbilities(input.provider, connection.access),
      };
    }

    const access = input.access ?? connection.access ?? "full";
    if (connection.state === "connected" && connection.access === access) {
      return {
        provider: input.provider,
        status: "connected" as const,
        email: connection.email,
        access,
        abilities: connectionAbilities(input.provider, access),
      };
    }
    const url = new URL(
      `/api/personal-mail/${input.provider}/connect`,
      applicationOrigin()
    );
    url.searchParams.set("access", access);
    const previousConnectionRemoved = connection.state === "connected";
    if (previousConnectionRemoved) await disconnectMail(scope, input.provider);
    return {
      provider: input.provider,
      status: "authorize" as const,
      access,
      abilities: connectionAbilities(input.provider, access),
      url: url.toString(),
      previousConnectionRemoved,
      notice: `${previousConnectionRemoved ? "Старое локальное подключение удалено; до повторного подключения Бро не имеет доступа к этому ящику. " : ""}Открой ссылку в браузере и войди в тот же аккаунт кабинета Бро. Затем подтверди доступ на странице почтового провайдера. Подключение завершится только после этого; пароли и токены в чат присылать не нужно.`,
    };
  },
});

export default defineDynamic({
  events: {
    "turn.started": (_event, context) => {
      const caller =
        context.session.auth.current ?? context.session.auth.initiator;
      if (
        caller?.principalType !== "user" ||
        !mailEnabled(scopeFromPrincipal(caller)) ||
        !mailProviderSchema.options.some(mailProviderConfigured)
      ) {
        return null;
      }
      return resolveModeValue(context, {
        interactive: { connect_mail: connectMail },
      });
    },
  },
});

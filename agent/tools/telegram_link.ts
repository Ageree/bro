import { defineDynamic, defineTool } from "eve/tools";
import { z } from "zod";
import { resolveModeValue } from "@agent/lib/mode";
import { scopeFromPrincipal } from "@agent/lib/principal-scope";
import {
  channelLinkTokenLifetimeMs,
  mintChannelLinkToken,
  readChannelIdentity,
} from "@db/services/channel-identities";
import {
  telegramLinkConfigured,
  telegramLinkUrl,
} from "@shared/identity/telegram-link";

export const linkTelegram = defineTool({
  description:
    "Create a one-time link that connects the user's Telegram account to this workspace, so they can talk to you from Telegram as the same account. Call this when the user asks to use Telegram, connect Telegram, or move the conversation there. It returns a t.me deep link that must be delivered to the user with send_message; the link works once and expires in 30 minutes. Opening it in Telegram starts a chat with the bot and finishes the connection. The result also reports the Telegram username already connected, when there is one.",
  inputSchema: z.object({}),
  async execute(_input, context) {
    const auth = context.session.auth.current;
    if (auth?.principalType !== "user") {
      throw new Error("An authenticated user is required to link Telegram.");
    }
    if (!telegramLinkConfigured()) {
      return {
        status: "not_configured",
        detail: "Телеграм на этом деплое не настроен, привязывать не к чему.",
      };
    }
    const scope = scopeFromPrincipal(auth);
    const [identity, token] = await Promise.all([
      readChannelIdentity(scope, "telegram"),
      mintChannelLinkToken(scope, "telegram"),
    ]);
    return {
      status: "ready",
      connectedUsername: identity?.username ?? null,
      expiresInMinutes: channelLinkTokenLifetimeMs / 60_000,
      url: telegramLinkUrl(token),
    };
  },
});

export default defineDynamic({
  events: {
    // The link is only useful from a conversation that is not already Telegram.
    "turn.started": (_event, context) =>
      context.channel.kind === "channel:telegram"
        ? null
        : resolveModeValue(context, {
            interactive: { link_telegram: linkTelegram },
          }),
  },
});

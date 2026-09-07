import type { HumanChannel } from "../../convex/lib/telegramPolicy.ts";

export type AuthAttrs = Readonly<Record<string, unknown>> | null | undefined;

export type TurnRouting = {
  channel?: HumanChannel;
  telegramChatId?: string;
  inkboxHandle?: string;
  ownerPhone?: string;
  canDeliver: boolean;
};

function firstAttr(attrs: AuthAttrs, key: string): string {
  const raw = attrs?.[key];
  if (typeof raw === "string") return raw.trim();
  if (Array.isArray(raw) && typeof raw[0] === "string") return raw[0].trim();
  return "";
}

export function routingFromAuth(attrs: AuthAttrs): TurnRouting {
  const telegramChatId = firstAttr(attrs, "telegramChatId");
  const inkboxHandle = firstAttr(attrs, "inkboxHandle");
  const ownerPhone = firstAttr(attrs, "ownerPhone");
  const origin = firstAttr(attrs, "origin");
  const stampedTelegram =
    firstAttr(attrs, "channel") === "telegram" || Boolean(telegramChatId);

  if (stampedTelegram) {
    return {
      channel: "telegram",
      ...(telegramChatId ? { telegramChatId } : {}),
      ...(inkboxHandle ? { inkboxHandle } : {}),
      ...(ownerPhone ? { ownerPhone } : {}),
      canDeliver: Boolean(telegramChatId),
    };
  }

  if (origin === "human") {
    return {
      channel: "imessage",
      ...(inkboxHandle ? { inkboxHandle } : {}),
      ...(ownerPhone ? { ownerPhone } : {}),
      canDeliver: true,
    };
  }

  return {
    ...(inkboxHandle ? { inkboxHandle } : {}),
    ...(ownerPhone ? { ownerPhone } : {}),
    canDeliver: false,
  };
}

export function routingTenant(routing: TurnRouting): {
  telegramChatId?: string;
  inkboxHandle?: string;
  lastChannel?: HumanChannel;
} {
  return {
    ...(routing.telegramChatId ? { telegramChatId: routing.telegramChatId } : {}),
    ...(routing.inkboxHandle ? { inkboxHandle: routing.inkboxHandle } : {}),
    ...(routing.channel ? { lastChannel: routing.channel } : {}),
  };
}

export function routingPhone(
  routing: TurnRouting,
  principalId?: string | null,
): string | undefined {
  const principal = typeof principalId === "string" ? principalId.trim() : "";
  if (principal) return principal;
  return routing.ownerPhone || undefined;
}

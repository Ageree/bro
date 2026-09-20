import type { HumanChannel } from "../../convex/lib/telegramPolicy.ts";

export type AuthAttrs = Readonly<Record<string, unknown>> | null | undefined;

export type TurnRouting = {
  channel?: HumanChannel;
  telegramChatId?: string;
  inkboxHandle?: string;
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
  const origin = firstAttr(attrs, "origin");
  const stampedTelegram =
    firstAttr(attrs, "channel") === "telegram" || Boolean(telegramChatId);

  if (stampedTelegram) {
    return {
      channel: "telegram",
      ...(telegramChatId ? { telegramChatId } : {}),
      ...(inkboxHandle ? { inkboxHandle } : {}),
      canDeliver: Boolean(telegramChatId),
    };
  }

  if (origin === "human") {
    return {
      channel: "imessage",
      ...(inkboxHandle ? { inkboxHandle } : {}),
      canDeliver: true,
    };
  }

  return {
    ...(inkboxHandle ? { inkboxHandle } : {}),
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

/**
 * Whose turn this is, from the principal the transport stamped.
 *
 * There used to be a fallback to an `ownerPhone` turn attribute. Nothing
 * writes that attribute any more: it came only from the group-chat auth
 * builder, and groups are gone. A fallback that can never fire is worse than
 * none — it reads like a second, quieter way to decide who a turn belongs to,
 * which is exactly the kind of thing that produced the `local-dev` leak.
 */
export function routingPhone(
  _routing: TurnRouting,
  principalId?: string | null,
): string | undefined {
  const principal = typeof principalId === "string" ? principalId.trim() : "";
  return principal || undefined;
}

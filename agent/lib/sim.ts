/** Loopback iMessage lane for cloud/AI testers. Never talks to Inkbox.
 *  Conversation ids are `sim:…`; phones are reserved +1555… so a play
 *  cannot bind a real person's tenant by accident. */

export const SIM_PREFIX = "sim:";
export const SIM_PHONE_RE = /^\+1555\d{7}$/;
export const DEFAULT_SIM_PHONE = "+15550001000";

export type SimKind = "text" | "media" | "tapback" | "group";

export type SimBubble = {
  kind: SimKind;
  text?: string;
  media?: string;
  reaction?: string;
  targetMessageId?: string;
  to?: string[];
  at: number;
  messageId: string;
};

const inbox = new Map<string, SimBubble[]>();
const messageConvo = new Map<string, string>();
const waiters = new Map<string, Array<(ok: boolean) => void>>();

export function isSimConversation(id: string | undefined | null): boolean {
  return typeof id === "string" && id.startsWith(SIM_PREFIX);
}

export function isSimPhone(phone: string | undefined | null): boolean {
  return typeof phone === "string" && SIM_PHONE_RE.test(phone);
}

export function isSimMessageId(id: string | undefined | null): boolean {
  return typeof id === "string" && id.startsWith("sim-");
}

export function simConversationId(phone: string): string {
  return `${SIM_PREFIX}${phone}`;
}

export function parseSimPhone(raw: unknown): string | undefined {
  if (typeof raw !== "string") return undefined;
  const phone = raw.trim();
  return isSimPhone(phone) ? phone : undefined;
}

export function parseSimConversation(raw: unknown, phone: string): string {
  if (typeof raw === "string" && isSimConversation(raw.trim())) {
    return raw.trim();
  }
  return simConversationId(phone);
}

export function rememberSimMessage(
  messageId: string,
  conversationId: string,
): void {
  messageConvo.set(messageId, conversationId);
}

export function conversationForSimMessage(
  messageId: string,
): string | undefined {
  return messageConvo.get(messageId);
}

export function peekSimBubbles(conversationId: string): SimBubble[] {
  return inbox.get(conversationId) ?? [];
}

export function takeSimBubbles(conversationId: string): SimBubble[] {
  const got = inbox.get(conversationId) ?? [];
  inbox.delete(conversationId);
  return got;
}

export function recordSimBubble(
  conversationId: string,
  bubble: Omit<SimBubble, "at" | "messageId"> & { messageId?: string },
): SimBubble {
  const recorded: SimBubble = {
    ...bubble,
    messageId: bubble.messageId ?? `sim-${crypto.randomUUID()}`,
    at: Date.now(),
  };
  const list = inbox.get(conversationId) ?? [];
  list.push(recorded);
  inbox.set(conversationId, list);
  rememberSimMessage(recorded.messageId, conversationId);
  return recorded;
}

export function settleSimTurn(conversationId: string): void {
  const list = waiters.get(conversationId);
  waiters.delete(conversationId);
  for (const resolve of list ?? []) resolve(true);
}

export function waitSimTurnSettled(
  conversationId: string,
  timeoutMs: number,
): Promise<boolean> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      const pending = waiters.get(conversationId);
      if (pending) {
        waiters.set(
          conversationId,
          pending.filter((fn) => fn !== onSettle),
        );
      }
      resolve(false);
    }, timeoutMs);
    const onSettle = (ok: boolean) => {
      clearTimeout(timer);
      resolve(ok);
    };
    const pending = waiters.get(conversationId) ?? [];
    pending.push(onSettle);
    waiters.set(conversationId, pending);
  });
}

/** Test-only: drop in-memory state between assertions. */
export function resetSimState(): void {
  inbox.clear();
  messageConvo.clear();
  for (const [id, pending] of waiters) {
    waiters.delete(id);
    for (const resolve of pending) resolve(false);
  }
}

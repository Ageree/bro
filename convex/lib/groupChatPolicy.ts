/** Pure group-chat policy. Inkbox groups need a dedicated line; inbound
 *  webhooks use snake_case. Shared-service 1:1 must never see a group
 *  conversation_id written onto the tenant — that clobbers wakeups/mail. */

export const GROUP_MEMORY_PREFIX = "group:";
export const MAX_GROUP_PARTICIPANTS = 16;
export const MIN_GROUP_CREATE = 2;
export const MAX_GROUP_CREATE = 8;

export const GROUP_PRIVATE_ONLY =
  "Это только в личке с Bro. Напиши мне отдельно, не в группе.";

export const GROUP_WELCOME = [
  "Я Bro — меня добавили в этот чат.",
  "Пишите «бро …», когда нужна помощь. Покупки, сейф и почта — лучше в личке.",
].join("\n");

export const GROUP_HOWTO = [
  "Добавить Bro в группу: сохрани карточку контакта и кинь этот номер в чат.",
  "В группе пиши «бро …» — иначе молчу, чтобы не спамить.",
  "Новый чат из лички: назови 2–8 номеров, открою сам (нужен номер Bro).",
].join("\n");

const GROUP_ATTR = "1";

export function isGroupMessage(msg: {
  is_group?: unknown;
  isGroup?: unknown;
}): boolean {
  return msg.is_group === true || msg.isGroup === true;
}

function readPhone(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  return normalizeE164(value);
}

export function normalizeE164(raw: string): string | undefined {
  const compact = raw.trim().replace(/[\s()-]/g, "");
  if (!/^\+?[0-9]{8,16}$/.test(compact)) return undefined;
  return compact.startsWith("+") ? compact : `+${compact}`;
}

/** Inbound groups: sender_number is who spoke; remote_number mirrors it. */
export function groupSenderPhone(msg: {
  sender_number?: unknown;
  senderNumber?: unknown;
  remote_number?: unknown;
  remoteNumber?: unknown;
}): string | undefined {
  return (
    readPhone(msg.sender_number) ??
    readPhone(msg.senderNumber) ??
    readPhone(msg.remote_number) ??
    readPhone(msg.remoteNumber)
  );
}

export function groupParticipantPhones(msg: {
  participants?: unknown;
}): string[] {
  return uniquePhones(Array.isArray(msg.participants) ? msg.participants : []);
}

export function uniquePhones(values: readonly unknown[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const value of values) {
    const phone = typeof value === "string" ? normalizeE164(value) : undefined;
    if (!phone || seen.has(phone)) continue;
    seen.add(phone);
    out.push(phone);
    if (out.length >= MAX_GROUP_PARTICIPANTS) break;
  }
  return out;
}

export function mergeParticipantPhones(
  existing: readonly string[],
  incoming: readonly string[],
): string[] {
  return uniquePhones([...existing, ...incoming]);
}

/** Identity owner is the group owner. Never the latest speaker. */
export function resolveGroupOwner(opts: {
  tenantPhone?: string;
  senderPhone?: string;
  participants?: readonly string[];
}): string | undefined {
  const tenant = opts.tenantPhone ? normalizeE164(opts.tenantPhone) : undefined;
  if (tenant) return tenant;
  const sender = opts.senderPhone ? normalizeE164(opts.senderPhone) : undefined;
  if (sender) return sender;
  const first = uniquePhones(opts.participants ?? [])[0];
  return first;
}

export function foldGroupAsk(text: string): string {
  return text
    .replace(/^\[voice\]\s*/i, "")
    .replace(/^\[group[^\]]*\]\s*/i, "")
    .normalize("NFC")
    .replace(/ё/gi, "е")
    .toLowerCase()
    .replace(/[\u200b-\u200d\ufeff]/g, "")
    .replace(/\p{Extended_Pictographic}/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Mention-required, Tomo-style. "брони" / "browser" must not match.
 * Cyrillic needs Unicode letter edges — JS `\b` is ASCII-only.
 */
export function shouldReplyInGroup(text: string): boolean {
  const folded = foldGroupAsk(text);
  if (!folded) return false;
  return /(?:^|[^\p{L}\p{N}_])@?(?:bro|бро)(?:$|[^\p{L}\p{N}_])/u.test(folded);
}

export function groupMemoryScope(conversationId: string): string | null {
  const id = conversationId.trim();
  if (!id) return null;
  return `${GROUP_MEMORY_PREFIX}${id}`;
}

export function isGroupMemoryScope(scope: string): boolean {
  return scope.startsWith(GROUP_MEMORY_PREFIX) && scope.length > GROUP_MEMORY_PREFIX.length;
}

export function isGroupAuthFlag(
  attributes: Record<string, unknown> | undefined,
): boolean {
  const raw = attributes?.isGroup;
  const flag = Array.isArray(raw) ? raw[0] : raw;
  return flag === GROUP_ATTR || flag === true || flag === "true";
}

export function groupAuthAttributes(opts: {
  conversationId: string;
  inkboxHandle: string;
  messageId?: string;
  origin: "human";
  senderPhone: string;
  ownerPhone: string;
}): Record<string, string> {
  const attrs: Record<string, string> = {
    conversationId: opts.conversationId,
    inkboxHandle: opts.inkboxHandle,
    origin: opts.origin,
    isGroup: GROUP_ATTR,
    senderPhone: opts.senderPhone,
    ownerPhone: opts.ownerPhone,
  };
  if (opts.messageId) attrs.messageId = opts.messageId;
  return attrs;
}

export function groupTaggedText(senderPhone: string, text: string): string {
  return `[group ${senderPhone}] ${text}`;
}

export function tagGroupUserContent(
  senderPhone: string,
  content: string | Array<{ type: "text"; text: string } | { type: string }>,
): string | Array<{ type: "text"; text: string } | { type: string }> {
  const tagged = groupTaggedText(senderPhone, typeof content === "string" ? content : "");
  if (typeof content === "string") return tagged;
  return content.map((part) => {
    if (part.type === "text" && "text" in part) {
      return { type: "text" as const, text: groupTaggedText(senderPhone, part.text) };
    }
    return part;
  });
}

export function parseGroupCreatePhones(
  phones: readonly string[],
  exclude?: readonly string[],
): { ok: true; to: string[] } | { ok: false; reason: string } {
  const blocked = new Set(
    (exclude ?? [])
      .map((p) => normalizeE164(p))
      .filter((p): p is string => Boolean(p)),
  );
  const to = uniquePhones(phones).filter((p) => !blocked.has(p));
  if (to.length < MIN_GROUP_CREATE) {
    return { ok: false, reason: `need ${MIN_GROUP_CREATE}–${MAX_GROUP_CREATE} distinct E.164 numbers` };
  }
  if (to.length > MAX_GROUP_CREATE) {
    return { ok: false, reason: `at most ${MAX_GROUP_CREATE} numbers` };
  }
  return { ok: true, to };
}

export function groupWelcomeText(): string {
  return GROUP_WELCOME;
}

export function groupHowtoText(): string {
  return GROUP_HOWTO;
}

export function groupPrivateOnlyText(): string {
  return GROUP_PRIVATE_ONLY;
}

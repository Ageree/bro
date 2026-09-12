/** Photon iMessage policy. No I/O. Shared pool (Free/Pro): one assigned +1 per user. */

export const PHOTON_GROUPS_PAUSED =
  "Группы в iMessage сейчас на паузе — на тарифе Photon Pro Bro только в личке. Когда будет свой номер, откроем снова.";

export const PHOTON_ONBOARD_BODY = "Привет";

/** Photon's shared Bro +1 (Spectrum Pro pool). Landing/cabinet deep-link here. */
export const PHOTON_SHARED_NUMBER = "+16282649335";

/** Open Messages to Bro. iPhone treats `sms:` as iMessage when the line is blue. */
export function photonOnboardLink(
  assignedNumber: string = PHOTON_SHARED_NUMBER,
  body = PHOTON_ONBOARD_BODY,
): string {
  return photonSmsLink(assignedNumber, body);
}

/** Basic auth for Photon Spectrum. Web APIs only — Convex default runtime has no `Buffer`. */
export function photonBasicAuthHeader(projectId: string, projectSecret: string): string {
  const raw = `${projectId}:${projectSecret}`;
  const bytes = new TextEncoder().encode(raw);
  let binary = "";
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]!);
  }
  return `Basic ${btoa(binary)}`;
}

export function refuseSmsText(): string {
  return "Bro отвечает только в iMessage (синие пузыри). Выключи «Отправлять как SMS» в Настройки → Сообщения и напиши ещё раз.";
}

export function isBluePhotonService(opts: {
  service?: string | null;
  wasDowngraded?: boolean | null;
}): boolean {
  if (opts.wasDowngraded) return false;
  const service = (opts.service ?? "").trim().toLowerCase();
  if (!service) return true;
  if (service === "sms" || service === "rcs") return false;
  if (service === "imessage" || service === "iMessage".toLowerCase()) return true;
  return service === "unknown";
}

export function normalizePhotonE164(raw: string): string | undefined {
  let compact = raw.trim().replace(/[\s()-]/g, "");
  if (/^8[0-9]{10}$/.test(compact)) compact = `+7${compact.slice(1)}`;
  if (!/^\+?[1-9][0-9]{6,14}$/.test(compact)) return undefined;
  return compact.startsWith("+") ? compact : `+${compact}`;
}

/** Messages deep link. iPhone opens the thread; body is prefilled. */
export function photonSmsLink(assignedNumber: string, body = PHOTON_ONBOARD_BODY): string {
  const n = assignedNumber.trim();
  const digits = n.replace(/[^\d+]/g, "");
  return `sms:${digits}&body=${encodeURIComponent(body)}`;
}

export function photonNudgeText(assignedNumber?: string): string {
  if (assignedNumber?.trim()) {
    return [
      "Bro переехал на новый iMessage.",
      `Напиши сюда с этого iPhone: ${assignedNumber.trim()}`,
      "В этот чат больше не отвечаю — почта Bro та же.",
    ].join("\n");
  }
  return [
    "Bro переехал на новый iMessage.",
    "Открой страницу bro и нажми «Получить своего бро» — откроется новый чат.",
    "В этот чат больше не отвечаю — почта Bro та же.",
  ].join("\n");
}

export function outboundIMessageConversation(opts: {
  requested?: string;
  photonConversationId?: string;
  inkboxConversationId?: string;
}): string | undefined {
  const requested = opts.requested?.trim();
  const photon = opts.photonConversationId?.trim();
  const inkbox = opts.inkboxConversationId?.trim();
  if (requested && inkbox && requested === inkbox) return photon || undefined;
  if (requested) return requested;
  return photon || undefined;
}

export function shouldNudgeInkboxThread(opts: {
  photonConversationId?: string;
  photonNudgeSentAt?: number;
}): "drop" | "nudge" | "ignore-bound" {
  if (opts.photonConversationId?.trim()) return "ignore-bound";
  if (opts.photonNudgeSentAt && opts.photonNudgeSentAt > 0) return "drop";
  return "nudge";
}

export function parsePhotonSenderPhone(input: {
  address?: unknown;
  phone?: unknown;
  id?: unknown;
}): string | undefined {
  for (const value of [input.address, input.phone, input.id]) {
    if (typeof value !== "string") continue;
    const phone = normalizePhotonE164(value);
    if (phone) return phone;
  }
  return undefined;
}

export function parsePhotonInboundJson(body: unknown): {
  spaceId?: string;
  messageId?: string;
  text?: string;
  service?: string;
  senderPhone?: string;
  event?: string;
  userId?: string;
  assignedPhoneNumber?: string;
  isEcho?: boolean;
} | undefined {
  if (!body || typeof body !== "object") return undefined;
  const rec = body as Record<string, unknown>;
  const event = typeof rec.event === "string" ? rec.event : undefined;
  const space = rec.space && typeof rec.space === "object"
    ? (rec.space as Record<string, unknown>)
    : undefined;
  const message = rec.message && typeof rec.message === "object"
    ? (rec.message as Record<string, unknown>)
    : undefined;
  const user = rec.user && typeof rec.user === "object"
    ? (rec.user as Record<string, unknown>)
    : undefined;
  if (!message && !space) return undefined;
  const sender = message?.sender && typeof message.sender === "object"
    ? (message.sender as Record<string, unknown>)
    : undefined;
  const content = message?.content && typeof message.content === "object"
    ? (message.content as Record<string, unknown>)
    : undefined;
  const text =
    content?.type === "text" && typeof content.text === "string"
      ? content.text
      : typeof message?.text === "string"
        ? message.text
        : undefined;
  const service =
    (typeof sender?.service === "string" && sender.service) ||
    (typeof message?.service === "string" && message.service) ||
    undefined;
  const direction =
    (typeof message?.direction === "string" && message.direction) ||
    (typeof rec.direction === "string" && rec.direction) ||
    "";
  const isEcho =
    direction.toLowerCase() === "outbound" ||
    (typeof event === "string" && /sent|outbound|echo/i.test(event));
  const assigned =
    (typeof space?.assignedPhoneNumber === "string" && space.assignedPhoneNumber) ||
    (typeof user?.assignedPhoneNumber === "string" && user.assignedPhoneNumber) ||
    undefined;
  const userId =
    (typeof user?.id === "string" && user.id) ||
    (typeof sender?.id === "string" && sender.id) ||
    (typeof space?.userId === "string" && space.userId) ||
    undefined;
  return {
    event,
    spaceId: typeof space?.id === "string" ? space.id : undefined,
    messageId: typeof message?.id === "string" ? message.id : undefined,
    text,
    service,
    senderPhone: parsePhotonSenderPhone({
      address: sender?.address,
      phone: sender?.phone,
      id: sender?.id,
    }),
    userId,
    assignedPhoneNumber: assigned,
    isEcho,
  };
}

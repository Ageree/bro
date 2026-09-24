import { createHash } from "node:crypto";
import { gmail, type gmail_v1 } from "@googleapis/gmail";
import type { ToolContext } from "eve/tools";
import { z } from "zod";
import { withGoogleAuth } from "./client";
import { emailAddressSchema } from "./email";

type GmailMessage = gmail_v1.Schema$Message;
type GmailPart = gmail_v1.Schema$MessagePart;

export const GMAIL_UPDATE_ACTIONS = [
  "archive",
  "move_to_inbox",
  "mark_read",
  "mark_unread",
  "star",
  "unstar",
] as const;

export type GmailUpdateAction = (typeof GMAIL_UPDATE_ACTIONS)[number];

export const gmailSearchInputSchema = z.object({
  maxResults: z.number().int().min(1).max(25).default(10),
  query: z.string().min(1).max(1_000),
});

export const gmailReadThreadInputSchema = z.object({
  threadId: z.string().min(1).max(200),
});

export const gmailUpdateInputSchema = z.object({
  messageIds: z.array(z.string().min(1).max(200)).min(1).max(100),
  update: z.enum(GMAIL_UPDATE_ACTIONS),
});

export const gmailComposeSchema = z
  .object({
    bcc: z.array(emailAddressSchema).max(20).default([]),
    body: z.string().min(1).max(100_000),
    cc: z.array(emailAddressSchema).max(20).default([]),
    replyToMessageId: z
      .string()
      .min(1)
      .max(200)
      .optional()
      .describe(
        "When answering an email: the Gmail message `id` (from gmail-search or gmail-read-thread) of the message being answered. The email then joins that message's thread with In-Reply-To and References set, and its subject becomes `Re: <original subject>`. Omit only for a brand-new conversation."
      ),
    subject: z
      .string()
      .min(1)
      .max(998)
      .optional()
      .describe(
        "Required for a new email. Ignored for a reply, which keeps the thread's subject so Gmail threads it."
      ),
    to: z.array(emailAddressSchema).min(1).max(20),
  })
  .refine(
    (input) =>
      input.replyToMessageId !== undefined || input.subject !== undefined,
    {
      message: "A new email needs a subject; a reply needs replyToMessageId.",
      path: ["subject"],
    }
  );

export type GmailCompose = z.infer<typeof gmailComposeSchema>;

/**
 * Metadata reads a search keeps in flight at once. Gmail limits concurrent
 * requests per user, and 25 parallel reads from one search were enough to
 * draw «Too many concurrent requests» on their own.
 */
const searchReadConcurrency = 5;

export async function searchGmail(
  ctx: ToolContext,
  query: string,
  maxResults: number
) {
  return withGmail(ctx, async (client) => {
    const listed = await client.users.messages.list(
      { maxResults, q: query, userId: "me" },
      { signal: ctx.abortSignal }
    );
    const ids = (listed.data.messages ?? []).flatMap(({ id }) =>
      id ? [id] : []
    );
    const messages = [];
    for (let start = 0; start < ids.length; start += searchReadConcurrency) {
      // oxlint-disable-next-line eslint/no-await-in-loop -- Batches bound the requests in flight.
      const batch = await Promise.all(
        ids.slice(start, start + searchReadConcurrency).map((id) =>
          client.users.messages.get(
            {
              format: "metadata",
              id,
              metadataHeaders: ["From", "To", "Subject", "Date", "Message-ID"],
              userId: "me",
            },
            { signal: ctx.abortSignal }
          )
        )
      );
      messages.push(...batch.map(({ data }) => minimizeMessage(data)));
    }
    return messages;
  });
}

export async function readGmailThread(ctx: ToolContext, threadId: string) {
  return withGmail(ctx, async (client) => {
    const { data: thread } = await client.users.threads.get(
      { format: "full", id: threadId, userId: "me" },
      { signal: ctx.abortSignal }
    );
    return {
      id: thread.id ?? threadId,
      messages: (thread.messages ?? []).slice(-20).map((message) =>
        Object.assign({}, minimizeMessage(message), {
          attachments: collectAttachments(message.payload),
          body: redactGoogleText(plainText(message.payload)),
        })
      ),
    };
  });
}

/**
 * Messages one turn may change through `gmail-update` without asking. Triage
 * that archived 23 emails and a refund question that marked 12 read changed
 * the mailbox in bulk on their own; past this, the person confirms a card.
 */
export const gmailUpdateWithoutApproval = 3;

/**
 * Whether a `gmail-update` call needs approval, counting the messages the
 * turn already changed (`updatedInTurn`) so a bulk change split into small
 * calls still asks.
 */
export function gmailUpdateNeedsApproval(
  input: { readonly messageIds?: readonly string[] } | undefined,
  updatedInTurn = 0
) {
  return (
    new Set(input?.messageIds ?? []).size + updatedInTurn >
    gmailUpdateWithoutApproval
  );
}

/**
 * Account-security mail in the inbox: Google's own sign-in and security
 * notices, and the usual subjects of alerts, sign-ins, password changes and
 * verification codes from anyone else. Such mail stays in the inbox whatever
 * triage decides, so the person still sees it.
 */
export const gmailSecurityAlertQuery = [
  "in:inbox {",
  "from:accounts.google.com",
  "from:no-reply@accounts.google.com",
  'subject:"security alert"',
  'subject:"оповещение системы безопасности"',
  'subject:"new sign-in"',
  'subject:"sign-in attempt"',
  'subject:"новый вход"',
  'subject:"вход в аккаунт"',
  'subject:"password changed"',
  'subject:"пароль изменён"',
  'subject:"пароль изменен"',
  'subject:"verification code"',
  'subject:"код подтверждения"',
  'subject:"2-step verification"',
  "}",
].join(" ");

export async function updateGmail(
  ctx: ToolContext,
  messageIds: string[],
  action: GmailUpdateAction
) {
  const requested = [...new Set(messageIds)];
  return withGmail(ctx, async (client) => {
    const alerts =
      action === "archive"
        ? await inboxSecurityAlerts(client, ctx.abortSignal)
        : new Set<string>();
    const kept = requested.filter((id) => alerts.has(id));
    const ids = requested.filter((id) => !alerts.has(id));
    if (ids.length > 0) {
      await client.users.messages.batchModify(
        {
          requestBody: { ids, ...gmailUpdateLabels(action) },
          userId: "me",
        },
        { signal: ctx.abortSignal }
      );
    }
    return { action, keptSecurityAlerts: kept, updatedCount: ids.length };
  });
}

/** Ids of the security alerts now in the inbox, found by one cheap search. */
async function inboxSecurityAlerts(
  client: ReturnType<typeof gmail>,
  signal: AbortSignal
) {
  const { data } = await client.users.messages.list(
    { maxResults: 500, q: gmailSecurityAlertQuery, userId: "me" },
    { signal }
  );
  return new Set(
    (data.messages ?? []).flatMap((message) => (message.id ? [message.id] : []))
  );
}

/** The headers of the message a reply answers, as Gmail stores them. */
export interface GmailReplyTarget {
  readonly inReplyTo: string | null;
  readonly messageId: string | null;
  readonly references: string | null;
  readonly subject: string | null;
  readonly threadId: string | null;
}

export async function sendGmail(ctx: ToolContext, payload: GmailCompose) {
  return withGmail(ctx, async (client) => {
    const requestBody = await composeRequest(ctx, client, payload);
    const { data } = await client.users.messages.send(
      { requestBody, userId: "me" },
      { signal: ctx.abortSignal }
    );
    return data;
  });
}

/** Saves an email as a Gmail draft, in the answered thread for a reply. */
export async function draftGmail(ctx: ToolContext, payload: GmailCompose) {
  return withGmail(ctx, async (client) => {
    const message = await composeRequest(ctx, client, payload);
    const { data } = await client.users.drafts.create(
      { requestBody: { message }, userId: "me" },
      { signal: ctx.abortSignal }
    );
    return data;
  });
}

async function composeRequest(
  ctx: ToolContext,
  client: ReturnType<typeof gmail>,
  payload: GmailCompose
) {
  const replyTo = payload.replyToMessageId
    ? await readReplyTarget(ctx, client, payload.replyToMessageId)
    : undefined;
  const stableId = createHash("sha256")
    .update(`${ctx.session.id}:${ctx.callId}`)
    .digest("hex")
    .slice(0, 48);
  const raw = Buffer.from(
    composeGmailMessage(payload, {
      messageId: `<openinstinct-${stableId}@local>`,
      replyTo,
    }),
    "utf8"
  ).toString("base64url");
  const threadId = replyTo?.threadId;
  return threadId ? { raw, threadId } : { raw };
}

async function readReplyTarget(
  ctx: ToolContext,
  client: ReturnType<typeof gmail>,
  id: string
): Promise<GmailReplyTarget> {
  const { data } = await client.users.messages.get(
    {
      format: "metadata",
      id,
      metadataHeaders: ["Message-ID", "References", "In-Reply-To", "Subject"],
      userId: "me",
    },
    { signal: ctx.abortSignal }
  );
  return {
    inReplyTo: header(data.payload, "In-Reply-To"),
    messageId: header(data.payload, "Message-ID"),
    references: header(data.payload, "References"),
    subject: header(data.payload, "Subject"),
    threadId: data.threadId ?? null,
  };
}

/** A reply chain keeps at most this many ancestors in References. */
const maximumReferences = 20;

/**
 * Builds the RFC 5322 message Gmail sends or drafts. A reply names the
 * answered message in In-Reply-To, extends its References chain, and keeps
 * its subject: Gmail threads a message only when all three line up with the
 * thread id.
 */
export function composeGmailMessage(
  payload: GmailCompose,
  options: {
    readonly messageId: string;
    readonly replyTo?: GmailReplyTarget | undefined;
  }
) {
  const replyTo = options.replyTo;
  const subject = replyTo
    ? replySubject(replyTo.subject ?? payload.subject ?? "")
    : (payload.subject ?? "");
  const parent = replyTo?.messageId ? safeHeader(replyTo.messageId) : null;
  const references = parent
    ? [
        ...angleAddresses(replyTo?.references ?? replyTo?.inReplyTo ?? ""),
        parent,
      ].slice(-maximumReferences)
    : [];
  const headers = [
    `To: ${payload.to.map(safeHeader).join(", ")}`,
    ...(payload.cc.length
      ? [`Cc: ${payload.cc.map(safeHeader).join(", ")}`]
      : []),
    ...(payload.bcc.length
      ? [`Bcc: ${payload.bcc.map(safeHeader).join(", ")}`]
      : []),
    `Subject: ${encodeHeaderValue(safeHeader(subject))}`,
    `Message-ID: ${options.messageId}`,
    ...(parent
      ? [`In-Reply-To: ${parent}`, `References: ${references.join("\r\n ")}`]
      : []),
    "MIME-Version: 1.0",
    'Content-Type: text/plain; charset="UTF-8"',
    "Content-Transfer-Encoding: base64",
  ];
  const body = Buffer.from(payload.body, "utf8")
    .toString("base64")
    .replace(/.{76}/gu, "$&\r\n");
  return `${headers.join("\r\n")}\r\n\r\n${body}`;
}

/** `Re: <subject>`, without stacking prefixes on an ongoing thread. */
export function replySubject(subject: string) {
  const trimmed = safeHeader(subject);
  return /^re:/iu.test(trimmed) ? trimmed : `Re: ${trimmed}`.trim();
}

function angleAddresses(value: string) {
  return value.match(/<[^<>\s]+>/gu) ?? [];
}

/**
 * A header value as RFC 2047 encoded words when it is not plain ASCII, so a
 * Cyrillic subject reaches every client intact. Each word stays within the
 * 75-character limit and never splits a character.
 */
export function encodeHeaderValue(value: string) {
  if (/^[\x20-\x7e]*$/u.test(value)) return value;
  const words: string[] = [];
  let chunk = "";
  for (const character of value) {
    if (Buffer.byteLength(chunk + character, "utf8") > 45) {
      words.push(chunk);
      chunk = "";
    }
    chunk += character;
  }
  if (chunk) words.push(chunk);
  return words
    .map(
      (word) => `=?UTF-8?B?${Buffer.from(word, "utf8").toString("base64")}?=`
    )
    .join("\r\n ");
}

export function gmailUpdateLabels(action: GmailUpdateAction) {
  switch (action) {
    case "archive":
      return { addLabelIds: [], removeLabelIds: ["INBOX"] };
    case "move_to_inbox":
      return { addLabelIds: ["INBOX"], removeLabelIds: [] };
    case "mark_read":
      return { addLabelIds: [], removeLabelIds: ["UNREAD"] };
    case "mark_unread":
      return { addLabelIds: ["UNREAD"], removeLabelIds: [] };
    case "star":
      return { addLabelIds: ["STARRED"], removeLabelIds: [] };
    case "unstar":
      return { addLabelIds: [], removeLabelIds: ["STARRED"] };
  }
  throw new Error("Unsupported Gmail update action.");
}

function header(part: GmailPart | undefined, name: string) {
  return (
    part?.headers?.find(
      (item) => item.name?.toLowerCase() === name.toLowerCase()
    )?.value ?? null
  );
}

function plainText(part: GmailPart | undefined): string {
  if (!part) return "";
  if (part.mimeType === "text/plain" && part.body?.data) {
    return decodeBase64Url(part.body.data);
  }
  for (const child of part.parts ?? []) {
    const text = plainText(child);
    if (text) return text;
  }
  if (part.mimeType === "text/html" && part.body?.data) {
    return decodeBase64Url(part.body.data)
      .replace(/<[^>]+>/gu, " ")
      .replace(/\s+/gu, " ");
  }
  return "";
}

function minimizeMessage(message: GmailMessage) {
  return {
    date: header(message.payload, "Date"),
    from: header(message.payload, "From"),
    id: message.id ?? null,
    labels: message.labelIds ?? [],
    rfcMessageId: header(message.payload, "Message-ID"),
    snippet: redactGoogleText(message.snippet ?? "", 500),
    subject: header(message.payload, "Subject"),
    threadId: message.threadId ?? null,
    to: header(message.payload, "To"),
  };
}

/**
 * The files attached to one message, found wherever they sit in the MIME tree.
 * A part is named by its `partId`: Gmail hands out a fresh `attachmentId`, a
 * few hundred characters long, on every read of the same message, so the
 * stable part number is what `gmail-attachment` asks for.
 */
function collectAttachments(part: GmailPart | undefined): {
  filename: string;
  mimeType: string | null;
  partId: string;
  size: number;
}[] {
  if (!part) return [];
  const own =
    part.filename && part.partId && (part.body?.attachmentId || part.body?.data)
      ? [
          {
            filename: part.filename,
            mimeType: part.mimeType ?? null,
            partId: part.partId,
            size: part.body.size ?? 0,
          },
        ]
      : [];
  const nested = (part.parts ?? []).flatMap((child) =>
    collectAttachments(child)
  );
  return [...own, ...nested];
}

function findAttachmentPart(
  part: GmailPart | undefined,
  partId: string
): GmailPart | undefined {
  if (!part) return undefined;
  if (part.partId === partId && part.filename) return part;
  for (const child of part.parts ?? []) {
    const found = findAttachmentPart(child, partId);
    if (found) return found;
  }
  return undefined;
}

/**
 * Downloads one attachment of one message within `maxBytes`. The size Gmail
 * reports is checked before the bytes are fetched, and the decoded bytes are
 * checked again, so an oversized file is never buffered twice.
 */
export async function readGmailAttachment(
  ctx: ToolContext,
  messageId: string,
  partId: string,
  maxBytes: number
) {
  return withGmail(ctx, async (client) => {
    const { data: message } = await client.users.messages.get(
      { format: "full", id: messageId, userId: "me" },
      { signal: ctx.abortSignal }
    );
    const part = findAttachmentPart(message.payload, partId);
    const filename = part?.filename;
    if (!part || !filename) return { kind: "missing" } as const;
    if ((part.body?.size ?? 0) > maxBytes) return { kind: "oversize" } as const;

    const attachmentId = part.body?.attachmentId;
    const encoded = attachmentId
      ? (
          await client.users.messages.attachments.get(
            { id: attachmentId, messageId, userId: "me" },
            { signal: ctx.abortSignal }
          )
        ).data.data
      : part.body?.data;
    if (!encoded) return { kind: "missing" } as const;
    const decoded = Buffer.from(encoded, "base64url");
    // A view over the decoded buffer rather than a copy of it.
    const bytes = new Uint8Array(
      decoded.buffer,
      decoded.byteOffset,
      decoded.byteLength
    );
    if (bytes.byteLength > maxBytes) return { kind: "oversize" } as const;
    return {
      bytes,
      filename,
      kind: "bytes",
      mimeType: part.mimeType ?? undefined,
    } as const;
  });
}

function safeHeader(value: string) {
  return value.replace(/[\r\n]+/gu, " ").trim();
}

function withGmail<T>(
  ctx: ToolContext,
  execute: (client: ReturnType<typeof gmail>) => Promise<T>
) {
  return withGoogleAuth(ctx, (auth) => execute(gmail({ auth, version: "v1" })));
}

function decodeBase64Url(value: string) {
  return Buffer.from(value, "base64url").toString("utf8");
}

const secretPatterns: readonly (readonly [RegExp, string])[] = [
  [/\b\d{6}\b/gu, "[six-digit code redacted]"],
  [/\bsk-(?:proj-)?[A-Za-z0-9_-]{12,}\b/gu, "[api key redacted]"],
  [/\bgh[pousr]_[A-Za-z0-9]{20,}\b/gu, "[github token redacted]"],
  [/\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/gu, "[aws key redacted]"],
  [/\bAIza[A-Za-z0-9_-]{30,}\b/gu, "[google api key redacted]"],
  [/\b(?:bearer\s+)[A-Za-z0-9._~+/-]+=*\b/giu, "Bearer [token redacted]"],
  [
    /\b(password|passcode|api[_ -]?key|access[_ -]?token|refresh[_ -]?token|client[_ -]?secret)\s*[:=]\s*(?:"[^"]*"|'[^']*'|[^\s,;]+)/giu,
    "$1=[credential redacted]",
  ],
  [/\b(?:\d[ -]*?){13,19}\b/gu, "[payment number redacted]"],
];

function redactGoogleText(value: string, maxLength = 12_000) {
  let redacted = value.slice(0, maxLength);
  for (const [pattern, replacement] of secretPatterns) {
    redacted = redacted.replace(pattern, replacement);
  }
  return redacted;
}

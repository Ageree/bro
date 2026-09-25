import { createHash } from "node:crypto";
import type { ToolContext } from "eve/tools";
import { z } from "zod";
import {
  type GoogleClient,
  googleApiErrorStatus,
  googleUrl,
  withGoogleAuth,
} from "./client";
import { emailAddressSchema } from "./email";

/** The person's own mailbox in the Gmail REST API. */
const gmailApi = "https://gmail.googleapis.com/gmail/v1/users/me";

const gmailHeaderSchema = z.object({ name: z.string(), value: z.string() });

/** One node of a message's MIME tree, as far as Bro reads it. */
const gmailPartSchema = z.object({
  body: z
    .object({
      attachmentId: z.string().optional(),
      data: z.string().optional(),
      size: z.number().optional(),
    })
    .optional(),
  filename: z.string().optional(),
  headers: z.array(gmailHeaderSchema).optional(),
  mimeType: z.string().optional(),
  partId: z.string().optional(),
  get parts() {
    return z.array(gmailPartSchema).optional();
  },
});

type GmailPart = z.infer<typeof gmailPartSchema>;

const gmailMessageSchema = z.object({
  id: z.string().optional(),
  labelIds: z.array(z.string()).optional(),
  payload: gmailPartSchema.optional(),
  snippet: z.string().optional(),
  threadId: z.string().optional(),
});

type GmailMessage = z.infer<typeof gmailMessageSchema>;

const gmailMessageListSchema = z.object({
  messages: z
    .array(z.object({ id: z.string(), threadId: z.string().optional() }))
    .optional(),
  nextPageToken: z.string().optional(),
});

const gmailThreadSchema = z.object({
  id: z.string().optional(),
  messages: z.array(gmailMessageSchema).optional(),
});

const gmailDraftSchema = z.object({
  id: z.string().optional(),
  message: z
    .object({ id: z.string().optional(), threadId: z.string().optional() })
    .optional(),
});

const gmailAttachmentSchema = z.object({ data: z.string().optional() });

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
  forReply: z
    .boolean()
    .optional()
    .describe(
      "true when you are about to answer in this thread (reply or draft): the read then also brings the person's own earlier emails to this addressee (`yourEarlierEmails`) for their voice. Leave it out for plain reading."
    ),
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
        "Required for a new email. For a reply, pass the thread's subject too so the approval card names the thread; the reply itself keeps the thread's own subject so Gmail threads it."
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

function messageUrl(id: string, query?: Parameters<typeof googleUrl>[2]) {
  return googleUrl(gmailApi, `/messages/${encodeURIComponent(id)}`, query);
}

export async function searchGmail(
  ctx: ToolContext,
  query: string,
  maxResults: number
) {
  return withGoogleAuth(ctx, async (google) => {
    const listed = await google.json(gmailMessageListSchema, {
      url: googleUrl(gmailApi, "/messages", { maxResults, q: query }),
    });
    const ids = (listed.messages ?? []).map(({ id }) => id);
    const messages = [];
    for (let start = 0; start < ids.length; start += searchReadConcurrency) {
      // oxlint-disable-next-line eslint/no-await-in-loop -- Batches bound the requests in flight.
      const batch = await Promise.all(
        ids.slice(start, start + searchReadConcurrency).map((id) =>
          google.json(gmailMessageSchema, {
            url: messageUrl(id, {
              format: "metadata",
              metadataHeaders: [
                "From",
                "To",
                "Cc",
                "Subject",
                "Date",
                "Message-ID",
              ],
            }),
          })
        )
      );
      messages.push(...batch.map(minimizeMessage));
    }
    return messages;
  });
}

/**
 * Reads one thread. With `voice`, a read for a reply also brings the
 * person's own latest emails to the other side of the thread
 * (`yourEarlierEmails`): a reply written without them came out as a template
 * on «ты» to someone the person had written «Ирина Павловна, добрый день!»
 * for years (RU d09, EN D5). The lookup costs a search and three full
 * messages, so it runs only for a reply, never for a mailing or a robot,
 * once per addressee in a turn (`known`) and at most `left` more times.
 */
export async function readGmailThread(
  ctx: ToolContext,
  threadId: string,
  options: {
    readonly voice?: {
      readonly known: readonly string[];
      readonly left: number;
    } | null;
  } = {}
) {
  return withGoogleAuth(ctx, async (google) => {
    const thread = await google.json(gmailThreadSchema, {
      url: googleUrl(gmailApi, `/threads/${encodeURIComponent(threadId)}`, {
        format: "full",
      }),
    });
    const messages = (thread.messages ?? []).slice(-20);
    const read = {
      id: thread.id ?? threadId,
      messages: messages.map((message) => {
        const sentByYou = message.labelIds?.includes("SENT") ?? false;
        return Object.assign({}, minimizeMessage(message), {
          attachments: collectAttachments(message.payload),
          body: redactGoogleText(plainText(message.payload)),
          senderUtcOffset: sentByYou
            ? null
            : dateHeaderOffset(header(message.payload, "Date")),
          sentByYou,
        });
      }),
    };
    const addressee = options.voice ? threadAddressee(messages) : null;
    if (!addressee || !options.voice) return read;
    if (options.voice.known.includes(addressee)) {
      return {
        ...read,
        yourEarlierEmails: { alreadyAbove: true, to: addressee },
      };
    }
    if (options.voice.left <= 0) return read;
    // The voice only helps the reply: a failed look at the sent mail leaves
    // the thread itself readable.
    let voice;
    try {
      voice = await earlierEmailsTo(google, addressee);
    } catch (error) {
      console.warn("[gmail] could not read the person's earlier emails", {
        status: googleApiErrorStatus(error),
      });
      return read;
    }
    return { ...read, yourEarlierEmails: voice };
  });
}

/** Sent emails a thread read brings as the person's voice. */
const voiceSampleCount = 3;

/** An address Gmail search may take inside quotes, nothing that could end them. */
const searchableAddress = /^[\w.%+'-]+@[\w-]+(?:\.[\w-]+)+$/u;

/** Gmail's tabs for mail no person wrote by hand. */
const automatedCategories = new Set([
  "CATEGORY_FORUMS",
  "CATEGORY_PROMOTIONS",
  "CATEGORY_SOCIAL",
  "CATEGORY_UPDATES",
]);

/**
 * Whether a letter came from a robot or a mailing, whose «voice» the person
 * never answers in: a list or auto-submitted header, a no-reply sender, or
 * one of Gmail's automated tabs.
 */
function automatedLetter(message: GmailMessage) {
  const autoSubmitted = header(message.payload, "Auto-Submitted");
  const precedence = header(message.payload, "Precedence");
  const sender = headerAddress(header(message.payload, "From")) ?? "";
  return (
    header(message.payload, "List-Unsubscribe") !== null ||
    header(message.payload, "List-Id") !== null ||
    (autoSubmitted !== null && autoSubmitted.trim().toLowerCase() !== "no") ||
    (precedence !== null && /bulk|list|junk/iu.test(precedence)) ||
    /^(?:no-?reply|do-?not-?reply|mailer-daemon|notifications?)[@+]/iu.test(
      sender
    ) ||
    (message.labelIds ?? []).some((label) => automatedCategories.has(label))
  );
}

/**
 * The address a reply in this thread goes to: whoever last wrote to the
 * person (their Reply-To, else From), or, in a thread only the person wrote
 * in, whom they wrote to. None for a robot or a mailing.
 */
function threadAddressee(messages: readonly GmailMessage[]) {
  const theirs = messages.findLast(
    (message) => !(message.labelIds?.includes("SENT") ?? false)
  );
  if (theirs && automatedLetter(theirs)) return null;
  const address = theirs
    ? headerAddress(
        header(theirs.payload, "Reply-To") ?? header(theirs.payload, "From")
      )
    : headerAddress(header(messages.at(-1)?.payload, "To"));
  return address && searchableAddress.test(address) ? address : null;
}

/** The first address in a From, To or Reply-To header, lower-cased. */
export function headerAddress(value: string | null | undefined) {
  if (!value) return null;
  const address =
    /<([^<>\s]+@[^<>\s]+)>/u.exec(value)?.[1] ??
    /[^\s<>,;"]+@[^\s<>,;"]+/u.exec(value)?.[0];
  return address ? address.toLowerCase() : null;
}

/**
 * The UTC offset a Date header was stamped in, `+05:00`: many clients stamp
 * the sender's own clock, so a non-zero offset hints at their time zone
 * when the letter names no city. A zero offset or a zone name says nothing:
 * Microsoft 365 and relays stamp UTC whatever the sender's zone, and
 * RFC 5322 reads `-0000` as «unknown».
 */
export function dateHeaderOffset(value: string | null) {
  if (!value) return null;
  const numeric = /([+-])(\d{2}):?(\d{2})(?:\s*\([^)]*\))?\s*$/u.exec(value);
  const [, sign = "+", hours = "00", minutes = "00"] = numeric ?? [];
  if (!numeric || (hours === "00" && minutes === "00")) return null;
  return `${sign}${hours}:${minutes}`;
}

/**
 * The person's latest sent emails to `address`, reduced to what makes their
 * voice: greeting, sign-off and the text before any quote. With none to this
 * address, their latest sent emails at all, marked as such.
 */
async function earlierEmailsTo(google: GoogleClient, address: string) {
  const toAddressee = await sentMessages(google, `in:sent to:"${address}"`);
  const sameAddressee = toAddressee.length > 0;
  const emails = sameAddressee
    ? toAddressee
    : await sentMessages(google, "in:sent");
  return {
    emails: emails.map((message) =>
      Object.assign(
        {
          date: header(message.payload, "Date"),
          subject: header(message.payload, "Subject"),
          to: header(message.payload, "To"),
        },
        voiceSample(redactGoogleText(plainText(message.payload)))
      )
    ),
    sameAddressee,
    to: address,
  };
}

async function sentMessages(google: GoogleClient, query: string) {
  const listed = await google.json(gmailMessageListSchema, {
    url: googleUrl(gmailApi, "/messages", {
      maxResults: voiceSampleCount,
      q: query,
    }),
  });
  return Promise.all(
    (listed.messages ?? []).slice(0, voiceSampleCount).map(({ id }) =>
      google.json(gmailMessageSchema, {
        url: messageUrl(id, { format: "full" }),
      })
    )
  );
}

/**
 * Where the quote of the answered letter begins in a reply: a `>` line, a
 * forwarded or original-message rule, or the attribution line clients put
 * above the quote («On … wrote:», «… написал:», Gmail's Russian
 * «чт, 24 сент. 2026 г. в 16:40, Ирина <irina@…>:»).
 */
const quoteStart =
  /^(?:>|-{2,}\s*(?:original message|forwarded message|исходное сообщение|пересылаемое сообщение)|on\s.{1,200}\swrote:$|.{1,200}\s(?:писал|написал|написала|пишет)(?:\(а\))?:$|.{1,200}<[^<>\s]+@[^<>\s]+>:$)/iu;

/** Lines short enough to be a greeting or a sign-off rather than a paragraph. */
const formulaMaxLength = 60;

/**
 * An email's own words and the formulas that frame them: the first line as
 * the greeting and the last as the sign-off, when they are short enough to
 * be formulas («Ирина Павловна, добрый день!», «Спасибо! Хорошего дня.»,
 * «Best,» with the name under it). The quote of an earlier letter and a
 * `-- ` signature are left out.
 */
export function voiceSample(body: string) {
  const own: string[] = [];
  for (const line of body.replaceAll(/\r\n?/gu, "\n").split("\n")) {
    const trimmed = line.trim();
    if (trimmed === "--" || quoteStart.test(trimmed)) break;
    own.push(line.trimEnd());
  }
  const text = own
    .join("\n")
    .replaceAll(/\n{3,}/gu, "\n\n")
    .trim();
  const lines = text
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  const first = lines[0];
  const last = lines.at(-1);
  const beforeLast = lines.at(-2);
  const signOff =
    lines.length > 2 &&
    last !== undefined &&
    beforeLast !== undefined &&
    beforeLast.length <= 30 &&
    beforeLast.endsWith(",")
      ? `${beforeLast}\n${last}`
      : last;
  return {
    greeting:
      first !== undefined &&
      lines.length > 1 &&
      first.length <= formulaMaxLength
        ? first
        : null,
    signOff:
      signOff !== undefined &&
      lines.length > 1 &&
      signOff.length <= formulaMaxLength
        ? signOff
        : null,
    text: text.slice(0, 600),
  };
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
  return withGoogleAuth(ctx, async (google) => {
    const alerts =
      action === "archive"
        ? await inboxSecurityAlerts(google)
        : new Set<string>();
    const kept = requested.filter((id) => alerts.has(id));
    const ids = requested.filter((id) => !alerts.has(id));
    if (ids.length > 0) {
      await google.json(z.unknown(), {
        body: { ids, ...gmailUpdateLabels(action) },
        method: "POST",
        url: googleUrl(gmailApi, "/messages/batchModify"),
      });
    }
    return { action, keptSecurityAlerts: kept, updatedCount: ids.length };
  });
}

/** Ids of the security alerts now in the inbox, found by one cheap search. */
async function inboxSecurityAlerts(google: GoogleClient) {
  const listed = await google.json(gmailMessageListSchema, {
    url: googleUrl(gmailApi, "/messages", {
      maxResults: 500,
      q: gmailSecurityAlertQuery,
    }),
  });
  return new Set((listed.messages ?? []).map((message) => message.id));
}

/** The headers of the message a reply answers, as Gmail stores them. */
export interface GmailReplyTarget {
  readonly inReplyTo: string | null;
  readonly messageId: string | null;
  readonly references: string | null;
  readonly subject: string | null;
  readonly threadId: string | null;
}

const sentMessageSchema = z.object({
  id: z.string().optional(),
  threadId: z.string().optional(),
});

export async function sendGmail(ctx: ToolContext, payload: GmailCompose) {
  return withGoogleAuth(ctx, async (google) =>
    google.json(sentMessageSchema, {
      body: await composeRequest(ctx, google, payload),
      method: "POST",
      url: googleUrl(gmailApi, "/messages/send"),
    })
  );
}

/** Saves an email as a Gmail draft, in the answered thread for a reply. */
export async function draftGmail(ctx: ToolContext, payload: GmailCompose) {
  return withGoogleAuth(ctx, async (google) =>
    google.json(gmailDraftSchema, {
      body: { message: await composeRequest(ctx, google, payload) },
      method: "POST",
      url: googleUrl(gmailApi, "/drafts"),
    })
  );
}

/** A subject as a person compares it: reply and forward marks, quotes and case aside. */
function comparableSubject(subject: string) {
  return subject
    .toLowerCase()
    .replace(
      /^(?:\s*(?:re|fwd?|aw|wg|отв|ответ|пересл)\s*(?:\[\d+\])?\s*:\s*)+/iu,
      ""
    )
    .replaceAll(/[«»"“”„']/gu, "")
    .replaceAll(/\s+/gu, " ")
    .trim();
}

/**
 * Whether the subject a reply's card showed names the thread it goes into:
 * the same subject or one inside the other («Встреча» for «Re: Встреча в
 * четверг»). A thread with no subject matches any.
 */
export function subjectNamesThread(cardSubject: string, threadSubject: string) {
  const card = comparableSubject(cardSubject);
  const thread = comparableSubject(threadSubject);
  if (thread.length === 0 || card === thread) return true;
  const shorter = card.length < thread.length ? card : thread;
  const longer = shorter === card ? thread : card;
  return shorter.length >= 3 && longer.includes(shorter);
}

async function composeRequest(
  ctx: ToolContext,
  google: GoogleClient,
  payload: GmailCompose
) {
  const replyTo = payload.replyToMessageId
    ? await readReplyTarget(google, payload.replyToMessageId)
    : undefined;
  // The card named the thread by the subject in the call; the reply goes
  // into the thread of the answered message, so the two must agree.
  if (
    replyTo?.subject &&
    payload.subject &&
    !subjectNamesThread(payload.subject, replyTo.subject)
  ) {
    throw new Error(
      `Nothing sent: the approval card named the thread «${payload.subject}», but the message being answered is in «${replyTo.subject}». Find the right email and call again with its Gmail id and that thread's subject.`
    );
  }
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
  google: GoogleClient,
  id: string
): Promise<GmailReplyTarget> {
  const message = await google.json(gmailMessageSchema, {
    url: messageUrl(id, {
      format: "metadata",
      metadataHeaders: ["Message-ID", "References", "In-Reply-To", "Subject"],
    }),
  });
  return {
    inReplyTo: header(message.payload, "In-Reply-To"),
    messageId: header(message.payload, "Message-ID"),
    references: header(message.payload, "References"),
    subject: header(message.payload, "Subject"),
    threadId: message.threadId ?? null,
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
      (item) => item.name.toLowerCase() === name.toLowerCase()
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
    cc: header(message.payload, "Cc"),
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
  return withGoogleAuth(ctx, async (google) => {
    const message = await google.json(gmailMessageSchema, {
      url: messageUrl(messageId, { format: "full" }),
    });
    const part = findAttachmentPart(message.payload, partId);
    const filename = part?.filename;
    if (!part || !filename) return { kind: "missing" } as const;
    if ((part.body?.size ?? 0) > maxBytes) return { kind: "oversize" } as const;

    const attachmentId = part.body?.attachmentId;
    const encoded = attachmentId
      ? (
          await google.json(gmailAttachmentSchema, {
            url: googleUrl(
              gmailApi,
              `/messages/${encodeURIComponent(messageId)}/attachments/${encodeURIComponent(attachmentId)}`
            ),
          })
        ).data
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

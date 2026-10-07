import { createHash } from "node:crypto";

import {
  claimMailSend,
  completeMailSend,
  getMailCredentials,
  uncertainMailSend,
} from "@db/services/mail";
import { ImapFlow } from "imapflow";
import { simpleParser } from "mailparser";
import { createTransport } from "nodemailer";
import addressparser from "nodemailer/lib/addressparser";
import MailComposer from "nodemailer/lib/mail-composer";
import { z } from "zod";

import type { AccessScope } from "@shared/identity/access-scope";
import type { MailProvider } from "@shared/mail/schema";
import { mailServerHosts } from "@shared/mail/schema";
import type { MessageAddressObject, SearchObject } from "imapflow";
import type { AddressObject, ParsedMail } from "mailparser";
import type { SMTPTransportOptions } from "nodemailer";

const maxMessageBytes = 10 * 1024 * 1024;
const maxTextLength = 100_000;
const maxBodyBytes = 200_000;
const maxRecipients = 20;
const maxBatchSize = 100;
const emailSchema = z.email();

const smtpOptions = {
  port: 465,
  secure: true,
  authMethod: "XOAUTH2",
  forceAuth: true,
  tls: { rejectUnauthorized: true, minVersion: "TLSv1.2" },
  logger: false,
  debug: false,
  dnsTimeout: 15_000,
  connectionTimeout: 15_000,
  greetingTimeout: 15_000,
  socketTimeout: 30_000,
  disableFileAccess: true,
  disableUrlAccess: true,
} satisfies SMTPTransportOptions;

export interface MailMessageReference {
  mailbox: string;
  uid: number;
  uidValidity: string;
}

export interface MailComposition {
  provider: MailProvider;
  to: string[];
  cc?: string[];
  subject: string;
  body: string;
  reply?: MailMessageReference;
}

class MailClientError extends Error {}

function checkHeader(value: string, maxLength = 998) {
  if (
    value.length > maxLength ||
    Array.from(value).some(
      (character) =>
        character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127
    )
  ) {
    throw new MailClientError("Mail headers contain an invalid value.");
  }
  return value;
}

function checkMailbox(mailbox: string) {
  checkHeader(mailbox, 1024);
  if (!mailbox.trim()) throw new MailClientError("A mailbox is required.");
  return mailbox;
}

function checkReference(reference: MailMessageReference) {
  checkMailbox(reference.mailbox);
  if (
    !Number.isSafeInteger(reference.uid) ||
    reference.uid < 1 ||
    reference.uid > 4_294_967_295 ||
    !/^[1-9]\d{0,9}$/u.test(reference.uidValidity) ||
    BigInt(reference.uidValidity) > 4_294_967_295n
  ) {
    throw new MailClientError("A valid mail UID and UIDVALIDITY are required.");
  }
}

function parseRecipient(value: string) {
  const parsed = addressparser(checkHeader(value), { flatten: true });
  const address = parsed[0];
  if (
    parsed.length !== 1 ||
    !address ||
    !emailSchema.safeParse(address.address).success
  ) {
    throw new MailClientError(
      "Each recipient must be one valid email address."
    );
  }
  checkHeader(address.name);
  return { name: address.name, address: address.address };
}

function normalizeComposition(input: MailComposition) {
  const to = input.to.map(parseRecipient);
  const cc = (input.cc ?? []).map(parseRecipient);
  if (!to.length || to.length + cc.length > maxRecipients) {
    throw new MailClientError("Mail requires 1–20 recipients.");
  }
  checkHeader(input.subject);
  if (
    Buffer.byteLength(input.body, "utf8") > maxBodyBytes ||
    input.body.includes("\u0000")
  ) {
    throw new MailClientError(
      "Mail text exceeds the 200 KB limit or contains invalid characters."
    );
  }
  if (input.reply) checkReference(input.reply);
  return {
    to,
    cc,
    subject: input.subject,
    body: input.body,
    reply: input.reply,
  };
}

function requireWriteAccess(
  credentials: Awaited<ReturnType<typeof getMailCredentials>>
) {
  if (credentials.access !== "full") {
    throw new MailClientError(
      "This mail connection is read-only. Reconnect with full access to write."
    );
  }
}

async function withImap<T>(
  provider: MailProvider,
  credentials: Awaited<ReturnType<typeof getMailCredentials>>,
  operation: (client: ImapFlow) => Promise<T>
) {
  const client = new ImapFlow({
    host: mailServerHosts[provider].imap,
    port: 993,
    secure: true,
    auth: { user: credentials.email, accessToken: credentials.accessToken },
    tls: { rejectUnauthorized: true, minVersion: "TLSv1.2" },
    logger: false,
    logRaw: false,
    emitLogs: false,
    disableAutoIdle: true,
    disableCompression: true,
    disableBinary: true,
    connectionTimeout: 15_000,
    greetingTimeout: 15_000,
    socketTimeout: 30_000,
    maxLineLength: 256 * 1024,
    maxLiteralSize: maxMessageBytes + 1,
    maxResponseSize: maxMessageBytes + 256 * 1024,
    idHashAlgorithm: "sha256",
  });
  client.on("response", () => {
    if (!client.authenticated && client.secureConnection) {
      client.capabilities.delete("AUTH=OAUTHBEARER");
      client.capabilities.set("AUTH=XOAUTH2", true);
    }
  });
  client.on("error", () => {
    client.close();
  });
  const deadline = setTimeout(() => {
    client.close();
  }, 90_000);
  try {
    await client.connect();
    return await operation(client);
  } catch (error) {
    if (error instanceof MailClientError) throw error;
    throw new MailClientError(
      "The mail server operation failed or timed out. No automatic retry was attempted."
    );
  } finally {
    try {
      await client.logout();
    } catch {
      client.close();
    } finally {
      clearTimeout(deadline);
      client.close();
    }
  }
}

async function openReferencedMailbox(
  client: ImapFlow,
  reference: MailMessageReference,
  readOnly: boolean
) {
  checkReference(reference);
  const mailbox = await client.mailboxOpen(reference.mailbox, { readOnly });
  if (mailbox.uidValidity.toString() !== reference.uidValidity) {
    throw new MailClientError(
      "The mailbox UIDVALIDITY changed. Search again before using this message."
    );
  }
  if (!readOnly && mailbox.readOnly) {
    throw new MailClientError("The mail server opened this mailbox read-only.");
  }
  return mailbox;
}

function envelopeAddresses(addresses: MessageAddressObject[] | undefined) {
  return (addresses ?? []).slice(0, maxBatchSize).map((address) => ({
    name: (address.name ?? "").slice(0, 998),
    address: (address.address ?? "").slice(0, 998),
  }));
}

function parsedAddresses(
  addresses: AddressObject | AddressObject[] | undefined
) {
  const entries = addresses
    ? Array.isArray(addresses)
      ? addresses
      : [addresses]
    : [];
  return entries
    .flatMap((entry) => entry.value)
    .flatMap((address) => address.group ?? [address])
    .slice(0, maxBatchSize)
    .map((address) => ({
      name: address.name.slice(0, 998),
      address: (address.address ?? "").slice(0, 998),
    }));
}

function isoDate(value: Date | string | undefined) {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function messageReferences(parsed: ParsedMail) {
  const values = parsed.references ? [parsed.references].flat() : [];
  return values
    .filter(
      (value) => value.length <= 998 && /^<[^<>\s@]+@[^<>\s@]+>$/u.test(value)
    )
    .slice(-40);
}

async function findFolder(
  client: ImapFlow,
  kind: "Drafts" | "Sent" | "Archive" | "Inbox"
) {
  const aliases = {
    Drafts: ["drafts", "draft", "черновики"],
    Sent: ["sent", "sent items", "sent messages", "отправленные"],
    Archive: ["archive", "archives", "архив"],
    Inbox: ["inbox"],
  };
  const folders = (await client.list({ listOnly: true })).filter(
    (folder) => !folder.flags.has("\\Noselect")
  );
  const folder =
    folders.find(
      (entry) =>
        entry.specialUse === `\\${kind}` || entry.flags.has(`\\${kind}`)
    ) ??
    folders.find((entry) => aliases[kind].includes(entry.name.toLowerCase()));
  if (!folder) {
    throw new MailClientError(
      `The server has no identifiable ${kind.toLowerCase()} folder.`
    );
  }
  return folder.path;
}

async function composeMessage(
  client: ImapFlow,
  email: string,
  input: ReturnType<typeof normalizeComposition>
) {
  let to = input.to;
  let cc = input.cc;
  let inReplyTo: string | undefined;
  let references: string[] = [];
  if (input.reply) {
    await openReferencedMailbox(client, input.reply, true);
    const source = await client.fetchOne(
      input.reply.uid,
      { headers: ["message-id", "references", "from", "to", "cc", "reply-to"] },
      { uid: true }
    );
    if (!source)
      throw new MailClientError("The message to reply to no longer exists.");
    if (!source.headers)
      throw new MailClientError("The message to reply to no longer exists.");
    const parsed = await simpleParser(source.headers, {
      skipHtmlToText: true,
      skipTextToHtml: true,
    });
    inReplyTo = parsed.messageId;
    if (!inReplyTo || !/^<[^<>\s@]+@[^<>\s@]+>$/u.test(inReplyTo)) {
      throw new MailClientError(
        "The original message has no safe Message-ID for a threaded reply."
      );
    }
    checkHeader(inReplyTo);
    const self = email.toLowerCase();
    const from = parsedAddresses(parsed.from);
    const originalTo = parsedAddresses(parsed.to);
    const originalCc = parsedAddresses(parsed.cc);
    const replyTo = parsedAddresses(parsed.replyTo);
    const targets = from.some(
      (address) => address.address.toLowerCase() === self
    )
      ? originalTo.filter((address) => address.address.toLowerCase() !== self)
      : replyTo.length
        ? replyTo
        : from;
    const safeTargets = targets.map((address) => {
      checkHeader(address.name);
      return {
        name: address.name,
        address: parseRecipient(address.address).address,
      };
    });
    const expected = new Set(
      safeTargets.map((address) => address.address.toLowerCase())
    );
    const actual = new Set(to.map((address) => address.address.toLowerCase()));
    if (
      !expected.size ||
      expected.size !== actual.size ||
      [...actual].some((value) => !expected.has(value))
    ) {
      throw new MailClientError(
        "Reply recipients must match the original message's Reply-To or sender."
      );
    }
    const allowedCc = new Set(
      [...originalTo, ...originalCc]
        .map((address) => address.address.toLowerCase())
        .filter((address) => address !== self && !expected.has(address))
    );
    if (cc.some((address) => !allowedCc.has(address.address.toLowerCase()))) {
      throw new MailClientError(
        "Reply CC recipients must belong to the original conversation."
      );
    }
    to = safeTargets;
    cc = cc.filter(
      (address, index) =>
        cc.findIndex(
          (entry) =>
            entry.address.toLowerCase() === address.address.toLowerCase()
        ) === index
    );
    references = [...new Set([...messageReferences(parsed), inReplyTo])].slice(
      -40
    );
  }
  const message = new MailComposer({
    from: { name: "", address: parseRecipient(email).address },
    to,
    cc,
    subject: input.subject,
    text: input.body,
    inReplyTo,
    references,
    disableFileAccess: true,
    disableUrlAccess: true,
  }).compile();
  const raw = await message.build();
  if (raw.length > maxMessageBytes)
    throw new MailClientError("The composed message exceeds the size limit.");
  return {
    raw,
    envelope: message.getEnvelope(),
    messageId: message.messageId(),
  };
}

export async function searchMail(
  scope: AccessScope,
  input: {
    provider: MailProvider;
    mailbox?: string;
    text?: string;
    from?: string;
    subject?: string;
    since?: string;
    unread?: boolean;
    limit: number;
  }
) {
  const mailboxPath = checkMailbox(input.mailbox ?? "INBOX");
  if (
    !Number.isSafeInteger(input.limit) ||
    input.limit < 1 ||
    input.limit > maxBatchSize
  ) {
    throw new MailClientError("Search limit must be between 1 and 100.");
  }
  const since = input.since ? new Date(input.since) : undefined;
  if (since && Number.isNaN(since.getTime()))
    throw new MailClientError("Search date is invalid.");
  const query: SearchObject = {
    all: true,
    text: input.text === undefined ? undefined : checkHeader(input.text),
    from: input.from === undefined ? undefined : checkHeader(input.from),
    subject:
      input.subject === undefined ? undefined : checkHeader(input.subject),
    since,
    seen: input.unread === undefined ? undefined : !input.unread,
  };
  const credentials = await getMailCredentials(scope, input.provider);
  return withImap(input.provider, credentials, async (client) => {
    const mailbox = await client.mailboxOpen(mailboxPath, { readOnly: true });
    const uidValidity = mailbox.uidValidity.toString();
    const matches = await client.search(query, { uid: true });
    if (!matches)
      throw new MailClientError("Mail search could not be completed.");
    const selected = matches.toSorted((a, b) => b - a).slice(0, input.limit);
    const messages = selected.length
      ? await client.fetchAll(
          selected,
          { envelope: true, flags: true, internalDate: true },
          { uid: true }
        )
      : [];
    return {
      provider: input.provider,
      mailbox: mailbox.path,
      uidValidity,
      messages: messages
        .toSorted((a, b) => b.uid - a.uid)
        .map((message) => ({
          provider: input.provider,
          mailbox: mailbox.path,
          uid: message.uid,
          uidValidity,
          from: envelopeAddresses(message.envelope?.from),
          to: envelopeAddresses(message.envelope?.to),
          subject: (message.envelope?.subject ?? "").slice(0, 998),
          date: isoDate(message.envelope?.date ?? message.internalDate),
          snippet: "",
          unread: !message.flags?.has("\\Seen"),
          starred: message.flags?.has("\\Flagged") ?? false,
        })),
    };
  });
}

export async function readMail(
  scope: AccessScope,
  input: MailMessageReference & { provider: MailProvider }
) {
  checkReference(input);
  const credentials = await getMailCredentials(scope, input.provider);
  return withImap(input.provider, credentials, async (client) => {
    const mailbox = await openReferencedMailbox(client, input, true);
    const metadata = await client.fetchOne(
      input.uid,
      { size: true, flags: true, internalDate: true },
      { uid: true }
    );
    if (!metadata) throw new MailClientError("The message no longer exists.");
    if (metadata.size === undefined || metadata.size > maxMessageBytes) {
      throw new MailClientError("The message exceeds the 10 MB reading limit.");
    }
    const message = await client.fetchOne(
      input.uid,
      { source: { maxLength: maxMessageBytes + 1 } },
      { uid: true }
    );
    if (!message) throw new MailClientError("The message no longer exists.");
    if (!message.source)
      throw new MailClientError("The message no longer exists.");
    if (
      message.source.length > maxMessageBytes ||
      message.source.length !== metadata.size
    ) {
      throw new MailClientError(
        "The message could not be fetched completely within the size limit."
      );
    }
    const parsed = await simpleParser(message.source, {
      skipImageLinks: true,
      skipTextToHtml: true,
      skipTextLinks: true,
      maxHtmlLengthToParse: maxMessageBytes,
    });
    const text = parsed.text ?? "";
    return {
      provider: input.provider,
      mailbox: mailbox.path,
      uid: input.uid,
      uidValidity: mailbox.uidValidity.toString(),
      rfcMessageId: parsed.messageId?.slice(0, 998) ?? null,
      inReplyTo: parsed.inReplyTo?.slice(0, 998) ?? null,
      references: messageReferences(parsed),
      from: parsedAddresses(parsed.from),
      to: parsedAddresses(parsed.to),
      cc: parsedAddresses(parsed.cc),
      replyTo: parsedAddresses(parsed.replyTo),
      subject: (parsed.subject ?? "").slice(0, 998),
      date: isoDate(parsed.date ?? metadata.internalDate),
      text: text.slice(0, maxTextLength),
      textTruncated: text.length > maxTextLength,
      unread: !metadata.flags?.has("\\Seen"),
      starred: metadata.flags?.has("\\Flagged") ?? false,
      attachments: parsed.attachments
        .slice(0, maxBatchSize)
        .map((attachment) => ({
          filename: attachment.filename?.slice(0, 998) ?? null,
          contentType: attachment.contentType.slice(0, 256),
          size: attachment.size,
          contentDisposition: attachment.contentDisposition ?? null,
          contentId: attachment.contentId?.slice(0, 998) ?? null,
        })),
      attachmentsTruncated: parsed.attachments.length > maxBatchSize,
    };
  });
}

export async function draftMail(scope: AccessScope, input: MailComposition) {
  const credentials = await getMailCredentials(scope, input.provider);
  requireWriteAccess(credentials);
  const normalized = normalizeComposition(input);
  return withImap(input.provider, credentials, async (client) => {
    const mailbox = await findFolder(client, "Drafts");
    const message = await composeMessage(client, credentials.email, normalized);
    const receipt = await client.append(mailbox, message.raw, ["\\Draft"]);
    if (!receipt)
      throw new MailClientError(
        "The server did not confirm saving the draft. Do not retry blindly."
      );
    return {
      provider: input.provider,
      mailbox,
      uid: receipt.uid ?? null,
      uidValidity: receipt.uidValidity?.toString() ?? null,
      messageId: message.messageId,
      drafted: true,
    };
  });
}

export async function sendMail(
  scope: AccessScope,
  input: MailComposition,
  operationId: string
) {
  const credentials = await getMailCredentials(scope, input.provider);
  requireWriteAccess(credentials);
  const normalized = normalizeComposition(input);
  if (!operationId.trim() || operationId.length > 256)
    throw new MailClientError("A stable send operation ID is required.");
  const payloadHash = createHash("sha256")
    .update(
      JSON.stringify({
        provider: input.provider,
        from: credentials.email.toLowerCase(),
        to: normalized.to,
        cc: normalized.cc,
        subject: normalized.subject,
        body: normalized.body,
        reply: normalized.reply ?? null,
      })
    )
    .digest("hex");
  const claim = await claimMailSend(
    scope,
    input.provider,
    operationId,
    payloadHash
  );
  if (!claim.claimed) {
    if (claim.status !== "accepted") {
      throw new MailClientError(
        "This send is pending or its delivery is uncertain. It will not be sent again; check the mailbox first."
      );
    }
    return {
      provider: input.provider,
      sent: true,
      messageId: claim.messageId,
      accepted: null,
      rejected: null,
      replayed: true,
      sentCopySaved: null,
      warning:
        "SMTP acceptance was already recorded. Per-recipient results and sent-copy status are unavailable on replay; no message was resent.",
    };
  }
  const transport = createTransport({
    ...smtpOptions,
    host: mailServerHosts[input.provider].smtp,
    auth: {
      type: "OAuth2",
      user: credentials.email,
      accessToken: credentials.accessToken,
    },
  });
  try {
    const message = await withImap(input.provider, credentials, (client) =>
      composeMessage(client, credentials.email, normalized)
    );
    const receipt = await transport.sendMail({
      raw: message.raw,
      envelope: message.envelope,
      messageId: message.messageId,
    });
    if (!receipt.accepted.length)
      throw new MailClientError("SMTP did not accept any recipients.");
    const warnings: string[] = [];
    try {
      await completeMailSend(
        scope,
        input.provider,
        operationId,
        message.messageId
      );
    } catch {
      await uncertainMailSend(scope, input.provider, operationId).catch(
        () => false
      );
      warnings.push(
        "SMTP accepted the message, but its durable receipt could not be saved. Do not resend this operation."
      );
    }
    let sentCopySaved = false;
    try {
      await withImap(input.provider, credentials, async (client) => {
        const sentFolder = await findFolder(client, "Sent");
        await client.mailboxOpen(sentFolder, { readOnly: true });
        const existing = await client.search(
          { header: { "message-id": message.messageId } },
          { uid: true }
        );
        if (!existing)
          throw new MailClientError("The sent copy could not be checked.");
        if (existing.length) return;
        const copy = await client.append(sentFolder, message.raw, ["\\Seen"]);
        if (!copy)
          throw new MailClientError("The sent copy was not confirmed.");
      });
      sentCopySaved = true;
    } catch {
      warnings.push(
        "SMTP accepted the message, but saving its Sent copy failed or is uncertain. Do not resend the message."
      );
    }
    return {
      provider: input.provider,
      sent: true,
      messageId: message.messageId,
      accepted: receipt.accepted,
      rejected: receipt.rejected,
      replayed: false,
      sentCopySaved,
      warning: warnings.length ? warnings.join(" ") : null,
    };
  } catch {
    await uncertainMailSend(scope, input.provider, operationId).catch(
      () => false
    );
    throw new MailClientError(
      "The send failed or delivery is uncertain. This operation will not be retried; check Sent and the recipients before creating a new send."
    );
  } finally {
    transport.close();
  }
}

export async function updateMail(
  scope: AccessScope,
  input: {
    provider: MailProvider;
    mailbox: string;
    uidValidity: string;
    uids: number[];
    action:
      | "mark_read"
      | "mark_unread"
      | "star"
      | "unstar"
      | "archive"
      | "inbox";
  }
) {
  const credentials = await getMailCredentials(scope, input.provider);
  requireWriteAccess(credentials);
  const uids = [...new Set(input.uids)];
  if (!uids.length || uids.length > maxBatchSize)
    throw new MailClientError("Select 1–100 mail UIDs.");
  uids.forEach((uid) => {
    checkReference({
      mailbox: input.mailbox,
      uid,
      uidValidity: input.uidValidity,
    });
  });
  return withImap(input.provider, credentials, async (client) => {
    const mailbox = await openReferencedMailbox(
      client,
      {
        mailbox: input.mailbox,
        uid: uids[0] ?? 0,
        uidValidity: input.uidValidity,
      },
      false
    );
    const messages = await client.fetchAll(
      uids,
      { envelope: true },
      { uid: true }
    );
    if (messages.length !== uids.length)
      throw new MailClientError(
        "Some selected messages no longer exist. Search again before changing them."
      );
    if (input.action === "archive" || input.action === "inbox") {
      if (
        input.action === "archive" &&
        messages.some((message) =>
          /security\s*(?:alert|notification)|(?:suspicious|unusual)\s*(?:activity|sign.?in)|(?:password|парол[ья])|(?:verification|подтверждени[ея])\s*(?:code|код)|безопасност|подозрительн|(?:новый|необычный)\s*вход/iu.test(
            message.envelope?.subject ?? ""
          )
        )
      ) {
        throw new MailClientError(
          "Potential security or account-access alerts cannot be archived automatically."
        );
      }
      const destination = await findFolder(
        client,
        input.action === "archive" ? "Archive" : "Inbox"
      );
      if (destination === mailbox.path)
        return {
          provider: input.provider,
          mailbox: mailbox.path,
          uidValidity: input.uidValidity,
          uids,
          action: input.action,
          changed: false,
        };
      if (!client.capabilities.has("MOVE"))
        throw new MailClientError(
          "This server cannot move messages safely without deletion fallback."
        );
      const receipt = await client.messageMove(uids, destination, {
        uid: true,
      });
      if (!receipt)
        throw new MailClientError(
          "The move was not confirmed. Check both folders before retrying."
        );
      return {
        provider: input.provider,
        mailbox: mailbox.path,
        uidValidity: input.uidValidity,
        uids,
        action: input.action,
        changed: true,
        destination: receipt.destination,
        destinationUidValidity: receipt.uidValidity?.toString() ?? null,
        movedMessages: receipt.uidMap
          ? [...receipt.uidMap].map(([uid, destinationUid]) => ({
              uid,
              destinationUid,
            }))
          : null,
      };
    }
    const flag =
      input.action === "mark_read" || input.action === "mark_unread"
        ? "\\Seen"
        : "\\Flagged";
    const result =
      input.action === "mark_read" || input.action === "star"
        ? await client.messageFlagsAdd(uids, [flag], { uid: true })
        : await client.messageFlagsRemove(uids, [flag], { uid: true });
    if (!result)
      throw new MailClientError(
        "The server did not confirm updating these messages."
      );
    return {
      provider: input.provider,
      mailbox: mailbox.path,
      uidValidity: input.uidValidity,
      uids,
      action: input.action,
      changed: true,
    };
  });
}

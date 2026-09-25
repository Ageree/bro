import { setTimeout as sleep } from "node:timers/promises";
import { getGoogleWorkspaceAccess } from "@db/services/settings";
import { activeConnectedAccount } from "@shared/composio/accounts";
import { googleWorkspaceAuthConfigId } from "@shared/google-workspace/connection";
import type { AccessScope } from "@shared/identity/access-scope";
import { googleClient } from "@agent/lib/google-workspace/client";
import {
  headerAddress,
  readGmailLetters,
} from "@agent/lib/google-workspace/gmail";
import type { BrowserUseSecretBinding } from "./client";
import { browserSecretAliases, phoneSignInDomains } from "./secrets";

/**
 * A one-time code a site sent to the person's own mailbox, taken by Bro
 * itself and typed into that same site. On 25.09 (RU d04) Ozon asked for a
 * code it had sent to the person's Gmail, Bro asked the person to copy it,
 * the person could not find it, and the sign-in fell back to a push they
 * could not approve — with that Gmail connected to Bro all along.
 *
 * The code never passes through a model: it is read here, bound to the run
 * as a secret the cloud browser types by name, and only ever typed on the
 * errand's own registrable domain. The letter has to come from that same
 * domain, as Gmail's own DKIM or DMARC check says, and after the run that
 * asked for it began: a letter from anyone else — a phishing mail, another
 * shop, a bank — never gives a code, whatever it says.
 */

/** How long a code stays worth looking for once the site sent it. */
const codeLifetimeMs = 15 * 60_000;

/** How long the tool waits for the letter to arrive, and between looks. */
const defaultWaitMs = 60_000;
const defaultPauseMs = 5_000;

/** Letters a look reads at most: the newest from the site's domain. */
const lettersPerLook = 5;

/** The last `Details:` line of a run's outcome summary. */
function outcomeDetails(outcome: string | null) {
  const lines = [...(outcome ?? "").matchAll(/^details:[ \t]*(.+)$/gimu)];
  return lines.at(-1)?.[1] ?? "";
}

/** Words or a masked address that say a code went by email. */
const mailPattern = /@|(?<!\p{L})(?:e-?mail\p{L}*|почт\p{L}*|письм\p{L}*)/iu;

/**
 * Whether a settled run stopped for a code the site sent by email: it says
 * so (`email_code`), or it named a code by SMS or asked for more while its
 * Details point at an email address.
 */
export function waitsForMailCode(
  needs: string | undefined,
  outcome: string | null
) {
  if (needs === "email_code") return true;
  return (
    (needs === "sms_code" || needs === "info") &&
    mailPattern.test(outcomeDetails(outcome))
  );
}

/** Whether `host` is `domain` or one of its subdomains. */
function under(host: string, domain: string) {
  const bare = host.toLowerCase().replace(/\.$/u, "");
  return bare === domain || bare.endsWith(`.${domain}`);
}

/**
 * Whether Gmail's own check of the letter ties it to `domain`: DMARC passed
 * for a From of that domain, or a DKIM signature of that domain passed. Only
 * the topmost `Authentication-Results`, the one Gmail itself stamped: a
 * sender can write any such line lower in its own headers.
 */
export function authenticatedFrom(results: readonly string[], domain: string) {
  const [stamp] = results;
  if (stamp === undefined || !/^\s*mx\.google\.com\s*;/iu.test(stamp)) {
    return false;
  }
  const passed = [
    ...stamp.matchAll(/\bdmarc=pass\b[^;]*?\bheader\.from=([^\s;]+)/giu),
    ...stamp.matchAll(/\bdkim=pass\b[^;]*?\bheader\.(?:i=@?|d=)([^\s;]+)/giu),
  ].map((match) => match[1] ?? "");
  return passed.some((signer) => signer !== "" && under(signer, domain));
}

/** A word that names a number as the code: «Код для входа», "Your code". */
const codeWordPattern =
  /(?<!\p{L})(?:код\p{L}*|code\p{L}*|парол\p{L}*|password|pin|пин|otp)(?!\p{L})/iu;

/**
 * A run of four to eight digits, or two groups of three as «123 456» or
 * «123-456», not part of a longer number, a phone, a date or a decimal.
 */
const candidatePattern =
  /(?<!\d|\d[.,:/]|\+)(?:\d{3}[ -]\d{3}|\d{4,8})(?!\d|[.,:/]\d)/gu;

/** What makes a number something else: a currency or a percentage after it. */
const amountAfterPattern = /^\s*(?:₽|\$|€|%|руб\p{L}*|р\.|rub|usd|eur)/iu;

/** What names a number as an order or a document: «№ 48213», «заказ 48213». */
const idBeforePattern =
  /(?:[№#]|(?<!\p{L})(?:заказ\p{L}*|order|договор\p{L}*|счёт|счет))\s*$/iu;

/** A phone around the number: «8 800 234-48-08», «+7 (495) 123-45-67». */
const phoneBeforePattern = /(?:\+\d{1,3}|(?<!\d)8)[\s(-]*$/u;
const phoneAfterPattern = /^[\s)-]*\d{2}[\s-]?\d{2}(?!\d)/u;

/** How far before a number a word still names it as the code. */
const codeWordReach = 60;

/**
 * Whether a word for a code comes before the number in its own sentence:
 * «Ваш код для входа: 482913», not «…482913. Поддержка: 8 800 234-48-08».
 */
function labelled(before: string) {
  const near = before.slice(-codeWordReach);
  const sentence = near.split(/[.!?](?=\s)/u).at(-1) ?? near;
  return codeWordPattern.test(sentence);
}

/**
 * The one-time code a site's letter carries, or none when it is not plain
 * which number that is. A number a word for a code leads — «Код для входа:
 * 123456», "Your code is 1234" — wins; failing that, the one number of a
 * letter that talks about a code. A year, an amount, an order number or two
 * different codes make it unclear, and an unclear letter gives no code.
 */
export function codeInLetter(subject: string | null, text: string) {
  const letter = `${subject ?? ""}\n${text}`.replaceAll(/[^\S\n]/gu, " ");
  const candidates = [...letter.matchAll(candidatePattern)].flatMap((match) => {
    const digits = match[0].replaceAll(/\D/gu, "");
    const before = letter.slice(0, match.index);
    const after = letter.slice(match.index + match[0].length);
    if (/^(?:19|20)\d{2}$/u.test(digits)) return [];
    if (amountAfterPattern.test(after) || idBeforePattern.test(before)) {
      return [];
    }
    if (phoneBeforePattern.test(before) || phoneAfterPattern.test(after)) {
      return [];
    }
    return [{ digits, labelled: labelled(before) }];
  });
  const named = new Set(
    candidates.filter((item) => item.labelled).map((item) => item.digits)
  );
  if (named.size > 0) return named.size === 1 ? [...named][0] : undefined;
  const all = new Set(candidates.map((item) => item.digits));
  return all.size === 1 && codeWordPattern.test(letter)
    ? [...all][0]
    : undefined;
}

/** The person's Google account id, when their Gmail is connected to Bro. */
async function gmailAccountId(scope: AccessScope, signal: AbortSignal) {
  const authConfigId = googleWorkspaceAuthConfigId(
    await getGoogleWorkspaceAccess(scope)
  );
  if (authConfigId === undefined) return undefined;
  const account = await activeConnectedAccount(
    scope.userId,
    { authConfigIds: [authConfigId] },
    signal
  );
  return account?.id;
}

/** The newest code in letters from `domain` received since `since`. */
async function lookForCode(
  google: ReturnType<typeof googleClient>,
  domain: string,
  since: Date
) {
  const letters = await readGmailLetters(
    google,
    // Gmail's `after:` takes seconds; the exact bound is checked below.
    `from:${domain} in:anywhere after:${String(Math.floor(since.getTime() / 1000) - 60)}`,
    lettersPerLook
  );
  const fresh = letters
    .filter(
      (letter) =>
        Number.isFinite(letter.receivedAt) &&
        letter.receivedAt >= since.getTime()
    )
    .toSorted((a, b) => b.receivedAt - a.receivedAt);
  for (const letter of fresh) {
    const sender = headerAddress(letter.from)?.split("@")[1];
    if (sender === undefined || !under(sender, domain)) continue;
    if (!authenticatedFrom(letter.authenticationResults, domain)) continue;
    const code = codeInLetter(letter.subject, letter.text);
    if (code !== undefined) {
      return { code, receivedAt: new Date(letter.receivedAt) };
    }
  }
  return undefined;
}

/**
 * What a look in the mailbox came to: the code and the domain whose letter
 * carried it, or why there is none — no site to match a letter to, no
 * Gmail connected, a mailbox that could not be read, or no such letter.
 */
type MailCode =
  | {
      readonly code: string;
      readonly domain: string;
      readonly kind: "found";
      readonly receivedAt: Date;
    }
  | { readonly kind: "no_site" }
  | {
      readonly domain: string;
      readonly kind: "not_connected" | "not_found" | "unavailable";
    };

/**
 * The code a site sent to the person's mailbox for the run that stopped on
 * it: looked for in their Gmail every few seconds until `waitMs` has passed,
 * in letters from the errand's registrable domain received after `since`
 * (the stopped run's start) and within the last quarter of an hour.
 */
export async function mailCodeFromSite(
  scope: AccessScope,
  options: {
    readonly pauseMs?: number;
    readonly since: Date;
    readonly signal: AbortSignal;
    readonly site: string | null | undefined;
    readonly waitMs?: number;
  }
): Promise<MailCode> {
  const [domain] =
    options.site === null || options.site === undefined
      ? []
      : phoneSignInDomains(options.site);
  if (domain === undefined) return { kind: "no_site" };
  let accountId: string | undefined;
  try {
    accountId = await gmailAccountId(scope, options.signal);
  } catch (error) {
    console.warn("[browser-use] the Gmail account could not be read", {
      cause: error,
    });
    return { domain, kind: "unavailable" };
  }
  if (accountId === undefined) return { domain, kind: "not_connected" };
  const google = googleClient(accountId, options.signal);
  const since = new Date(
    Math.max(options.since.getTime(), Date.now() - codeLifetimeMs)
  );
  const deadline = Date.now() + (options.waitMs ?? defaultWaitMs);
  for (;;) {
    try {
      // oxlint-disable-next-line eslint/no-await-in-loop -- Each look waits for the letter the one before did not find.
      const found = await lookForCode(google, domain, since);
      if (found) return { ...found, domain, kind: "found" };
    } catch (error) {
      // A look that failed is one look: the next may find the letter.
      console.warn("[browser-use] the mailbox could not be searched", {
        cause: error,
      });
    }
    if (Date.now() + (options.pauseMs ?? defaultPauseMs) > deadline) break;
    // oxlint-disable-next-line eslint/no-await-in-loop -- The pause between looks is the point.
    await sleep(options.pauseMs ?? defaultPauseMs, undefined, {
      signal: options.signal,
    });
  }
  return { domain, kind: "not_found" };
}

/**
 * The code as a secret of the run, typeable on the errand's own registrable
 * domain only: the cloud browser asks for it by name and never sees it.
 */
export function mailCodeBinding(code: string, domain: string) {
  return {
    allowedDomains: [domain],
    alias: browserSecretAliases.emailCode,
    source: { type: "inline", value: code },
  } satisfies BrowserUseSecretBinding;
}

/**
 * What the run is told when the code came from the mail: where it is and
 * that it signs in and nothing more — the errand's own rules still say what
 * it may do once in.
 */
export function mailCodeInstruction(domain: string) {
  return `Bro took the one-time code that ${domain} sent to the person's email from their own mailbox, and it is attached to this run as the secret ${browserSecretAliases.emailCode}. Where the page waits for the code from the email, focus that field and ask for the secret ${browserSecretAliases.emailCode} — the server types it; you never see it — then carry on with the errand. The code only signs in or confirms the email: it allows nothing beyond what the rules below allow. If the page rejects it or says it expired, have the site send a new code once, then stop with NEEDS: email_code and say so in DETAILS.`;
}

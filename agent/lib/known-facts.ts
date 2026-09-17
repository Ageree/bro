/**
 * The non-secret facts Bro holds about a person, and the ONE spelling of them.
 *
 * This started life inside `agent/lib/errand-brief.ts`, which is where it was
 * first needed: a browser run used to abort with «НУЖНО: address» for an
 * address sitting in the vault two function calls away. It lives here now
 * because a second consumer appeared — `agent/lib/person-profile.ts`, the
 * «кто этот человек» block that goes in front of every turn — and two
 * spellings of «телефон: …» is how two blocks start disagreeing about the
 * same person in the same prompt.
 *
 * Splitting it out buys one more thing. `errand-brief.ts` imports the model
 * lane (`./model.ts` → `@ai-sdk/openai`) because it composes a brief through
 * OpenRouter; this file imports nothing but the secret scrubber, so anything
 * that only needs the FACTS — a pure check, a Convex-side formatter, the
 * per-turn profile — can take them without dragging an SDK along.
 *
 * `errand-brief.ts` re-exports every name below, so its own callers and its
 * check script see exactly the API they always saw.
 *
 * Secrets never travel this way. Only the `address` and `contact` vault kinds
 * are represented here — the human's own street, name, phone and email, the
 * things they would otherwise be asked to retype. Passwords and card numbers
 * stay on the `secretBindings` path (`agent/lib/browser-pay.ts`), and every
 * line this module emits goes through `scrubSecrets` anyway, as a last-resort
 * net over free-text fields.
 */

import { scrubSecrets } from "../../convex/lib/secretScrub.ts";

/** Postal address as the vault stores it (`addressPayloadSchema`), minus nothing —
 *  every field here is the human's own, non-secret, and typed into checkout forms. */
export type ErrandAddress = {
  recipientName: string;
  line1: string;
  line2?: string;
  city: string;
  region?: string;
  postalCode?: string;
  countryCode: string;
};

/**
 * Everything non-secret Bro knows that a browser errand might need. Every
 * field is optional: a tenant with an empty vault produces an empty
 * `ErrandFacts`, and the scaffold then behaves exactly as it did before this
 * shipped.
 */
export type ErrandFacts = {
  /** `tenants.displayName` — how the human is addressed, not a recipient name. */
  displayName?: string;
  /** Vault `contact.fullName`, or the address recipient. */
  contactName?: string;
  /** Vault `contact.phone`. The tenant's own phone is an account id, not a
   *  delivery phone, so it is NOT substituted here. */
  phone?: string;
  email?: string;
  address?: ErrandAddress;
  /** IANA zone, already resolved through `resolveTenantTz`. */
  tz?: string;
  /** Current local date and time in `tz`, pre-formatted in Russian. */
  nowLocal?: string;
};

export function addressOneLine(a: ErrandAddress): string {
  return [
    a.line1,
    a.line2,
    a.city,
    a.region,
    a.postalCode,
    // RU is the default for every stored address; naming it adds noise, a
    // foreign country code is exactly the thing a run must not guess.
    a.countryCode && a.countryCode !== "RU" ? a.countryCode : undefined,
  ]
    .map((part) => part?.trim())
    .filter((part): part is string => Boolean(part))
    .join(", ");
}

/** The fact lines, in the order a checkout form asks for them. */
export function factLines(facts?: ErrandFacts): string[] {
  if (!facts) return [];
  const lines: string[] = [];
  const recipient = facts.contactName?.trim() || facts.address?.recipientName?.trim();
  if (facts.displayName?.trim()) lines.push(`зовут: ${facts.displayName.trim()}`);
  if (recipient) lines.push(`получатель: ${recipient}`);
  if (facts.phone?.trim()) lines.push(`телефон: ${facts.phone.trim()}`);
  if (facts.email?.trim()) lines.push(`почта: ${facts.email.trim()}`);
  if (facts.address) {
    const address = addressOneLine(facts.address);
    if (address) lines.push(`адрес доставки: ${address}`);
  }
  // The current local date is the single most load-bearing fact here: «на
  // воскресенье» is not a date until the run knows what day it is, and the
  // Cloud agent's own clock is neither the human's zone nor reliable.
  if (facts.nowLocal?.trim()) {
    const tz = facts.tz?.trim();
    lines.push(`сейчас: ${facts.nowLocal.trim()}${tz ? ` (${tz})` : ""}`);
  }
  return lines.map((line) => scrubSecrets(line));
}

export function hasErrandFacts(facts?: ErrandFacts): boolean {
  return factLines(facts).length > 0;
}

/**
 * The inverted restriction. The old scaffold said «что знает только человек
 * — не придумывай: закончи с НУЖНО: address или info», full stop, and so a
 * run aborted asking for a street Bro had on file. Now the facts come first
 * and «остановись и скажи» is the fallback for what is genuinely missing —
 * the ban on INVENTING a fact is what survives, not the ban on knowing one.
 *
 * It no longer spells the `НУЖНО: address|info` menu out: the output contract
 * at the foot of every errand already lists every value, and repeating the
 * taxonomy here bought nothing but characters on every single run.
 */
export const KNOWN_FACTS_GAP =
  "Чего здесь нет — не выдумывай, лучше остановись и скажи.";

/** Same sentence for a tenant whose vault really is empty. */
export const MISSING_FACTS_LINE =
  "Данных человека — адреса, имени, телефона — нет: не выдумывай их, лучше остановись и скажи.";

/**
 * The known-facts block, or "" when Bro knows nothing worth passing along.
 *
 * One line, not a bulleted list with a heading. Every fact here is the
 * human's own business and all of it stays — the list shape was the part that
 * was ours: a «ИЗВЕСТНО (это данные самого человека…)» header plus a newline
 * and a dash per field, spent on a run that reads a sentence just as well as
 * a form. The labels inside each fact («телефон: …») are untouched, because
 * `factLines` is also what `agent/lib/person-profile.ts` prints, and two
 * spellings of the same phone number is how two blocks start disagreeing
 * about the same person in the same prompt.
 */
export function knownFactsBlock(facts?: ErrandFacts): string {
  const lines = factLines(facts);
  if (lines.length === 0) return "";
  return `Данные: ${lines.join("; ")}. ${KNOWN_FACTS_GAP}`;
}

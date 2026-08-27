import { decryptCard, isCardKey, splitCardPlain } from "../../convex/lib/cardPolicy.ts";
import * as convex from "./convex";

function cardKey(): string {
  const k = process.env.BRO_CARD_KEY ?? "";
  if (!isCardKey(k)) throw new Error("BRO_CARD_KEY missing");
  return k;
}

export async function mintCardLink(
  phoneE164: string,
): Promise<{ url: string; expiresAt: number }> {
  return convex.mintCardLink(phoneE164);
}

export async function cardStatus(phoneE164: string): Promise<{
  last4: string;
  brand: string;
  expMonth: number;
  expYear: number;
} | null> {
  const row = await convex.cardLast4(phoneE164);
  if (!row) return null;
  return {
    last4: row.last4,
    brand: row.brand,
    expMonth: row.expMonth,
    expYear: row.expYear,
  };
}

export async function forgetCard(phoneE164: string): Promise<void> {
  await convex.forgetCard(phoneE164);
}

/** Decrypt for Browser Use only. Do not put the return value in tool JSON. */
export async function cardForBrowser(phoneE164: string): Promise<{
  pan: string;
  cvc: string;
  expMonth: number;
  expYear: number;
  last4: string;
  brand: string;
} | null> {
  const row = await convex.cardBlobForPay(phoneE164);
  if (!row) return null;
  const { pan, cvc } = splitCardPlain(await decryptCard(row.blob, cardKey()));
  return {
    pan,
    cvc,
    expMonth: row.expMonth,
    expYear: row.expYear,
    last4: row.last4,
    brand: row.brand,
  };
}

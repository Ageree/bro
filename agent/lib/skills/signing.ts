/**
 * The consent rule as a workspace that signs documents reads it
 * (SIGN_WORKSPACES, `signOfCaller`): the one question before paying is also
 * the one before signing, in the core as in the full text, so compaction
 * cannot fold it away with the `sign` block and the core never tells the
 * model to sign without asking. Each pair is a phrase as
 * `agent/instructions/content/**` has it and as such a workspace reads it;
 * outside the flag nothing changes, byte for byte
 * (`tests/agent/skills/flag-off.test.ts`), and a test holds every phrase to
 * its files, so a reworded file cannot silently drop the rule.
 */
export const signingRewrites = [
  // execution-safety.md, in the full text and in the core.
  [
    "Подтверждения не спрашивай ни на что, кроме оплаты",
    "Подтверждения не спрашивай ни на что, кроме оплаты и подписи документа",
  ],
  // autonomy.md, in the full text and in the core.
  ["— ни одного, кроме оплаты", "— ни одного, кроме оплаты и подписи"],
] as const;

/** A text as a workspace that signs documents reads it. */
export function withSigningConsent(text: string) {
  return signingRewrites.reduce(
    (rewritten, [phrase, signing]) => rewritten.replaceAll(phrase, signing),
    text
  );
}

import { describe, expect, it } from "vitest";
import { instructionText } from "@agent/lib/skills/catalog";
import { signingRewrites, withSigningConsent } from "@agent/lib/skills/signing";

describe("the consent rule where the workspace signs", () => {
  it("rewrites phrases each layout of both files still has", () => {
    for (const layout of ["core", "full"] as const) {
      const texts = [
        instructionText("execution-safety", layout),
        instructionText("autonomy", layout),
      ];
      for (const [phrase] of signingRewrites) {
        expect(texts.some((text) => text.includes(phrase))).toBe(true);
      }
      for (const text of texts) {
        expect(withSigningConsent(text)).not.toBe(text);
      }
    }
  });
});

import { describe, expect, it } from "vitest";
import { errandFindsOnly } from "@agent/lib/browser-use/flash";
import { browserSecretBindings } from "@agent/lib/browser-use/secrets";

const errand = {
  bindings: [],
  paymentAllowed: false,
  staged: false,
  submits: false,
};

function secret(alias: string) {
  return {
    alias,
    allowedDomains: ["example.ru"],
    source: { type: "inline" as const, value: "x" },
  };
}

describe("an errand that only finds things", () => {
  it("still does when it may sign in with the person's phone", () => {
    // 25.10: every owner errand with a site bound the phone, and the code
    // engine never ran for him.
    const { bindings } = browserSecretBindings({
      card: undefined,
      login: undefined,
      signInPhone: "+79161234567",
      site: "https://hh.ru",
    });
    expect(bindings.map((binding) => binding.alias)).toEqual([
      "signin_phone",
      "signin_phone_digits",
    ]);
    expect(errandFindsOnly({ ...errand, bindings })).toBe(true);
    expect(errandFindsOnly(errand)).toBe(true);
  });

  it("does not once it may act, pay, stage or hand over a card or Госуслуги", () => {
    expect(errandFindsOnly({ ...errand, submits: true })).toBe(false);
    expect(errandFindsOnly({ ...errand, paymentAllowed: true })).toBe(false);
    expect(errandFindsOnly({ ...errand, staged: true })).toBe(false);
    for (const alias of ["card_number", "gosuslugi_username", "email_code"]) {
      expect(errandFindsOnly({ ...errand, bindings: [secret(alias)] })).toBe(
        false
      );
    }
  });
});

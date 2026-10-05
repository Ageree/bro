import { describe, expect, it } from "vitest";
import {
  composeBrowserContinuation,
  composeBrowserTask,
} from "@agent/tools/browser_task";

// RU 04.10, predubezhdai.ru: follow-ups told «the account already signed in»
// never signed in after the site had logged them out, a start stopped with
// NEEDS: password at «пароль выслан на почту» without trying the bound
// password, and runs opened a remembered /order page instead of the basket.

const site = "https://predubezhdai.ru";
const login = ["login_username", "login_password"];
const facts = "Known details you may type into forms:\nPhone: +79991234567";

function start(aliases: readonly string[], staging?: "person") {
  return composeBrowserTask({
    aliases,
    allowPayment: false,
    collectImages: false,
    consent: undefined,
    deliveryAddress: undefined,
    errand: "Закажи набор гвоздей",
    facts,
    home: undefined,
    site,
    staging,
  });
}

function followUp(
  aliases: readonly string[],
  freshBrowser?: "asked" | "staged"
) {
  return composeBrowserContinuation({
    aliases,
    allowPayment: false,
    collectImages: false,
    consent: undefined,
    deliveryAddress: undefined,
    errand: "Закажи набор гвоздей",
    facts,
    freshBrowser,
    message: "Да, оформляй",
    searching: false,
    site,
    staging: "person",
  });
}

describe("browser run sign-in rules", () => {
  it("never tells a follow-up that the account is still signed in", () => {
    for (const task of [
      followUp(login),
      followUp(login, "staged"),
      followUp(login, "asked"),
    ]) {
      expect(task).not.toContain("account already signed in");
      expect(task).not.toContain("the sign-in the last run had is kept");
    }
    expect(followUp(login)).toContain(
      "The site may have signed the account out since the last run: check that the page still shows the account signed in before you act in it, and if it does not, sign in again as the sign-in rules below allow"
    );
    expect(followUp(login, "staged")).toContain(
      "this browser's profile may still hold the sign-in the last run had, but check that the page shows it before you act in the account and sign in again when it does not"
    );
  });

  it("has a run with a bound password sign in itself and stop only on a rejected password", () => {
    for (const task of [start(login, "person"), followUp(login)]) {
      expect(task).toContain(
        "Never take it for granted that this browser is signed in to the person's account, even when an earlier run was or this task says so"
      );
      expect(task).toContain(
        "sign in yourself on the site's own sign-in form with login_username and login_password, then go on with the errand"
      );
      expect(task).toContain("«пароль выслан на почту»");
      expect(task).toContain(
        "A note that an account was created or a password was emailed is no reason to stop"
      );
      expect(task).toContain(
        "Stop with NEEDS: password only when the site rejects that password after you submitted it, and quote the site's message in DETAILS."
      );
    }
  });

  it("sends a run with a phone sign-in back to its own sign-in rule", () => {
    const task = start(["signin_phone", "signin_phone_digits"], "person");

    expect(task).toContain("Never take it for granted that this browser");
    expect(task).toContain(
      "sign in again as the sign-in paragraph above allows"
    );
    expect(task).not.toContain("sign in yourself on the site's own sign-in");
  });

  it("says nothing about an account to a run with no login", () => {
    expect(start([])).not.toContain("Never take it for granted");
    expect(start(["card_number", "card_expiry", "card_cvc"])).not.toContain(
      "Never take it for granted"
    );
  });

  it("starts a checkout from the basket, never from a remembered address", () => {
    for (const task of [start(login, "person"), followUp(login, "staged")]) {
      expect(task).toContain(
        "Start a checkout only from the site's own basket: open it with the site's basket button or «Корзина» link and press its checkout button"
      );
      expect(task).toContain(
        "Never open a checkout, order or payment page — a payment link or an order's payment page included — by an address you remember, guess or saw on an earlier run"
      );
      expect(task).toContain(
        "once you have signed in since it opened, go back to the basket and start the checkout again from its button"
      );
      // RU 04.10: the /cart button led to a legacy form; the header icon to
      // the working checkout.
      expect(task).toContain(
        "try the site's other way into checkout before stopping — the basket or bag icon in the page header"
      );
    }
    // A search with nothing to buy has no checkout to start.
    expect(start(login)).not.toContain("Start a checkout only");
  });

  it("types only the national digits after a field's +7 and picks suggestions", () => {
    const task = start(login, "person");

    expect(task).toContain(
      "If the phone field already shows the country code (+7) or a mask, type only the 10 digits after it (no +7, no 8, no spaces) and check that the field shows the number and the country you meant."
    );
    expect(task).toContain(
      "choose the matching entry from that list rather than leaving the typed text"
    );
    // Without the person's details there is nothing of theirs to type.
    expect(start(login)).not.toContain("type only the 10 digits");
  });

  it("reports only what the run did", () => {
    expect(start([])).toContain(
      "Report only what you did and saw on this run: say that you signed in, added, chose, filled in or confirmed something only once the page showed it done"
    );
  });
});

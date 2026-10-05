import { describe, expect, it } from "vitest";
import {
  composeBrowserContinuation,
  composeBrowserTask,
} from "@agent/tools/browser_task";
import type { ConfirmedSubmission } from "@shared/browser/submission";
import { formatRub } from "@shared/spending/limit";

// The checkout harness (browser-vm/worker/checkout_harness.py, 05.10): GPT
// Luna stopped right before paying while the person's yes sat mid-task, a
// run with no card bound hunted the shop for a saved card, and a follow-up
// opened a remembered /payment/<order> page by its address.

const site = "https://predubezhdai.ru";
const card = ["card_number", "card_expiry", "card_cvc", "card_holder"];
const login = ["login_username", "login_password"];
const errand =
  "Купи крем для рук VAM I NE SNILOS, 30 мл: самовывоз с Чистопрудного бульвара, оплата сохранённой картой.";
const cream: ConfirmedSubmission = {
  amount: "2 100 ₽",
  chargeRub: 2100,
  forWhom: "Савелий",
  kind: "order",
  paymentCapRub: 2310,
  personalData: ["имя", "телефон", "данные карты из сейфа"],
  what: "заказ крема для рук VAM I NE SNILOS, 30 мл",
  where: "predubezhdai.ru",
};

function start(
  aliases: readonly string[],
  submission: ConfirmedSubmission | undefined,
  allowPayment = true
) {
  return composeBrowserTask({
    aliases,
    allowPayment,
    collectImages: false,
    consent:
      submission === undefined
        ? undefined
        : { by: "person", kind: "confirmed", submission },
    deliveryAddress: undefined,
    errand,
    facts: undefined,
    home: undefined,
    site,
    staging: "person",
  });
}

function followUp(aliases: readonly string[]) {
  return composeBrowserContinuation({
    aliases,
    allowPayment: true,
    collectImages: false,
    consent: { by: "person", kind: "confirmed", submission: cream },
    deliveryAddress: undefined,
    errand,
    facts: undefined,
    message: "карту в сейф добавил, запускай оплату",
    searching: false,
    site,
    staging: "person",
  });
}

const goAhead = `The person asked for this order themselves and said yes to paying ${formatRub(2100)} for it: заказ крема для рук VAM I NE SNILOS, 30 мл, for Савелий, at predubezhdai.ru.`;
const payToConfirmation =
  "Place it, fill the card form with the saved card and press its pay button, until the site shows that the payment went through («Оплата прошла», the order confirmed): that is this errand, not a step to stop short of.";
const cardLater =
  "The saved card this order is to be paid with is not attached to this run: it is bound on the follow-up. Take the order up to the card form (or the page that asks for the card) and stop there with NEEDS: payment";
const noHunting =
  "Do not look for a saved card on the site — its account, its saved-cards pages, its API or the payment frame — and do not press the pay button with the form empty.";

describe("browser checkout rules", () => {
  it("opens a paid order's run with the person's go-ahead", () => {
    const task = start([...login, ...card], cream);
    expect(
      task.startsWith(`${goAhead} ${payToConfirmation}\n\n${errand}`)
    ).toBe(true);
    // The total is the one the person said yes to, not the ceiling above it.
    expect(task).not.toContain(`paying ${formatRub(2310)}`);
  });

  it("gives no go-ahead without a confirmed payment", () => {
    const { paymentCapRub: _cap, ...unpaid } = cream;
    for (const task of [start(card, unpaid), start(card, undefined, false)]) {
      expect(task).not.toContain("said yes to paying");
      expect(task.startsWith(errand)).toBe(true);
    }
  });

  it("stops at the card form when the saved card is bound only on the follow-up", () => {
    const task = start(login, cream);
    expect(task).toContain(
      "Place it and take it up to the card form: the saved card comes with the follow-up."
    );
    expect(task).not.toContain(payToConfirmation);
    expect(task).toContain(cardLater);
    expect(task).toContain(noHunting);
    // With the card bound, or nothing to pay, there is nothing to wait for.
    expect(start([...login, ...card], cream)).not.toContain(cardLater);
    expect(followUp([...login, ...card])).not.toContain(cardLater);
    expect(start(login, undefined, false)).not.toContain(cardLater);
    expect(followUp(login)).toContain(cardLater);
  });

  it("never opens a payment page by a remembered address", () => {
    for (const task of [start([...login, ...card], cream), followUp(card)]) {
      expect(task).toContain(
        "Never open a checkout, order or payment page — a payment link or an order's payment page included — by an address you remember, guess or saw on an earlier run: reach a payment page only through the site's own buttons and links on this run (the checkout's pay button, «Оплатить» beside the order in the account)."
      );
    }
  });
});

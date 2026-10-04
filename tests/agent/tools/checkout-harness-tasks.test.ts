import { writeFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { browserSecretBindings } from "@agent/lib/browser-use/secrets";
import {
  composeBrowserContinuation,
  composeBrowserTask,
} from "@agent/tools/browser_task";
import type { ConfirmedSubmission } from "@shared/browser/submission";
import {
  serializeLoginVaultPayload,
  serializePaymentCard,
} from "@shared/vault/schema";

/**
 * The task texts and secrets the browser checkout harness runs
 * (`browser-vm/worker/checkout_harness.py`): Bro's own composers and secret
 * bindings, with the errand of RU 04.10 (a hand cream on predubezhdai.ru,
 * picked up in a store, paid by the saved card). The harness serves its copy
 * of the shop at https://predubezhdai.ru to its own Chromium, so the texts and
 * the bindings are the ones a real run gets; the login and the card are the
 * harness's test values.
 *
 * `BRO_CHECKOUT_TASKS_OUT=browser-vm/worker/checkout_tasks.json
 * ./node_modules/.bin/vitest run tests/agent/tools/checkout-harness-tasks`
 * writes them; without it the test only checks they compose.
 */
const shop = "https://predubezhdai.ru";

const login = serializeLoginVaultPayload({
  authentication: { password: ["fixture", "only", "0410"].join("-"), type: "password" },
  identifier: { type: "email", value: "savely@example.com" },
  kind: "login",
  origin: shop,
  version: 2,
});

const card = serializePaymentCard({
  billingPostalCode: "101000",
  cardholderName: "SAVELY SOLOVYEV",
  expirationMonth: 1,
  expirationYear: 2031,
  kind: "payment-card",
  number: "4276550101324310",
  securityCode: "249",
  version: 1,
});

const facts = [
  "Known details you may type into forms:",
  "Name: Савелий Соловьев",
  "Phone: +7 921 781-88-76",
  "Email: savely@example.com",
].join("\n");

const errand =
  "Купи крем для рук VAM I NE SNILOS, 30 мл: самовывоз из магазина на Чистопрудном бульваре, 21, оплата сохранённой картой.";

const cream: ConfirmedSubmission = {
  amount: "2 100 ₽, самовывоз бесплатно",
  chargeRub: 2100,
  forWhom: "Савелий",
  items: [
    "Крем для рук VAM I NE SNILOS, 30 мл — 1 шт — 2 100 ₽",
    "Самовывоз: Чистопрудный бульвар, 21 — бесплатно",
  ],
  kind: "order",
  paymentCapRub: 2100,
  personalData: ["имя", "телефон", "email", "данные карты из сейфа"],
  what: "заказ крема для рук VAM I NE SNILOS, 30 мл",
  when: "самовывоз, срок сайт не показывает",
  where: "predubezhdai.ru",
};

function bound(withLogin: boolean, withCard: boolean) {
  return browserSecretBindings({
    card: withCard ? card : undefined,
    login: withLogin ? login : undefined,
    site: shop,
  });
}

/** The secrets as `startBrowserVmRun` sends them to the worker. */
function secrets(withLogin: boolean, withCard: boolean) {
  return bound(withLogin, withCard).bindings.map((binding) => ({
    alias: binding.alias,
    allowedDomains: [...binding.allowedDomains],
    value: binding.source.value,
  }));
}

function start(withLogin: boolean, withCard: boolean) {
  return composeBrowserTask({
    aliases: bound(withLogin, withCard).aliases,
    allowPayment: true,
    collectImages: false,
    consent: { by: "person", kind: "confirmed", submission: cream },
    deliveryAddress: undefined,
    errand,
    facts,
    home: "Москва, Россия",
    site: shop,
    staging: "person",
  });
}

function continuation(freshBrowser?: "asked") {
  return composeBrowserContinuation({
    aliases: bound(true, true).aliases,
    allowPayment: true,
    collectImages: false,
    consent: { by: "person", kind: "confirmed", submission: cream },
    deliveryAddress: undefined,
    errand,
    facts,
    ...(freshBrowser === undefined ? {} : { freshBrowser }),
    message: "карту в сейф добавил, запускай оплату",
    searching: false,
    site: shop,
    staging: "person",
  });
}

describe("checkout harness tasks", () => {
  it("composes the start and the follow-up of the RU 04.10 errand", () => {
    const tasks = {
      continuation: continuation(),
      continuationFresh: continuation("asked"),
      start: start(true, true),
      startGuest: start(false, true),
      startNoCard: start(true, false),
    };
    for (const task of Object.values(tasks)) {
      expect(task).toContain(`Site: ${shop}`);
      expect(task).not.toContain(["fixture", "only", "0410"].join("-"));
      expect(task).not.toContain("4276550101324310");
    }
    const out = process.env.BRO_CHECKOUT_TASKS_OUT;
    if (out !== undefined && out !== "") {
      const all = {
        secrets: {
          card: secrets(false, true),
          login: secrets(true, false),
          loginAndCard: secrets(true, true),
        },
        tasks,
      };
      writeFileSync(out, `${JSON.stringify(all, null, 2)}\n`);
    }
  });
});

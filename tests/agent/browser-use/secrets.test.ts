import { describe, expect, it } from "vitest";
import {
  browserSecretBindings,
  loginAllowedDomains,
  nationalPhoneDigits,
  paymentAllowedDomains,
  registrableDomain,
  selectBrowserVaultItems,
} from "@agent/lib/browser-use/secrets";
import {
  composeBrowserContinuation,
  composeBrowserTask,
} from "@agent/tools/browser_task";
import {
  serializeLoginVaultPayload,
  serializePaymentCard,
} from "@shared/vault/schema";

const password = "correct-horse-battery";
const cardNumber = "4111111111111111";
const securityCode = "737";

const login = serializeLoginVaultPayload({
  authentication: { password, type: "password" },
  identifier: { type: "email", value: "rider@example.com" },
  kind: "login",
  origin: "https://taxi.yandex.ru",
  version: 2,
});

const card = serializePaymentCard({
  billingPostalCode: "101000",
  cardholderName: "IVAN PETROV",
  expirationMonth: 4,
  expirationYear: 2031,
  kind: "payment-card",
  number: cardNumber,
  securityCode,
  version: 1,
});

const entries = [
  {
    account: "taxi.yandex.ru · r•••@example.com",
    id: "login-1",
    kind: "login",
  },
  {
    account: "shop.example.com · s•••@example.com",
    id: "login-2",
    kind: "login",
  },
  { account: "Visa · •••• 1111", id: "card-1", kind: "payment" },
];

describe("browser secret domains", () => {
  it("widens a host to its registrable domain but never past a public suffix", () => {
    expect(registrableDomain("taxi.yandex.ru")).toBe("yandex.ru");
    expect(registrableDomain("https://www.example.com")).toBe("example.com");
    expect(registrableDomain("shop.acme.co.uk")).toBe("acme.co.uk");
    expect(registrableDomain("store.myshopify.com")).toBe(
      "store.myshopify.com"
    );
    expect(registrableDomain("localhost")).toBeUndefined();
    expect(registrableDomain("127.0.0.1")).toBeUndefined();
  });

  it("lets a login reach the host it was actually saved for", () => {
    expect(
      loginAllowedDomains(
        "https://taxi.yandex.ru",
        "https://passport.yandex.ru"
      )
    ).toEqual(["yandex.ru"]);
    expect(
      loginAllowedDomains(
        "https://store.myshopify.com",
        "https://checkout.myshopify.com"
      )
    ).toEqual(["store.myshopify.com", "checkout.myshopify.com"]);
  });

  it("binds a login to the site alone and a card to the payment processors too", () => {
    expect(loginAllowedDomains("https://taxi.yandex.ru")).toEqual([
      "yandex.ru",
    ]);
    const payment = paymentAllowedDomains("https://taxi.yandex.ru");
    expect(payment[0]).toBe("yandex.ru");
    expect(payment).toContain("yookassa.ru");
    expect(payment).toContain("securepay.tinkoff.ru");
    expect(payment.length).toBeLessThanOrEqual(10);
    expect(loginAllowedDomains("https://taxi.yandex.ru")).not.toContain(
      "yookassa.ru"
    );
  });
});

describe("browser vault selection", () => {
  it("matches a login on the origin it was saved for", () => {
    expect(
      selectBrowserVaultItems(entries, {
        allowPayment: false,
        site: "https://taxi.yandex.ru",
      })
    ).toEqual({ loginId: "login-1", paymentId: undefined });
    expect(
      selectBrowserVaultItems(entries, {
        allowPayment: false,
        site: "https://www.other.example",
      })
    ).toEqual({ loginId: undefined, paymentId: undefined });
  });

  it("falls back to a login saved elsewhere on the same registrable domain", () => {
    const saved = [
      { account: "yandex.ru · i•••@example.com", id: "login-3", kind: "login" },
      {
        account: "passport.yandex.ru · p•••@example.com",
        id: "login-4",
        kind: "login",
      },
    ];

    expect(
      selectBrowserVaultItems(saved, {
        allowPayment: false,
        site: "https://taxi.yandex.ru",
      }).loginId
    ).toBe("login-3");
    expect(
      selectBrowserVaultItems(saved.slice(1), {
        allowPayment: false,
        site: "https://taxi.yandex.ru",
      }).loginId
    ).toBe("login-4");
  });

  it("prefers the login saved for the exact host", () => {
    expect(
      selectBrowserVaultItems(
        [
          {
            account: "yandex.ru · i•••@example.com",
            id: "login-3",
            kind: "login",
          },
          ...entries,
        ],
        { allowPayment: false, site: "https://taxi.yandex.ru" }
      ).loginId
    ).toBe("login-1");
  });

  it("never matches a login across registrable domains", () => {
    expect(
      selectBrowserVaultItems(entries, {
        allowPayment: false,
        site: "https://shop.example.org",
      }).loginId
    ).toBeUndefined();
    expect(
      selectBrowserVaultItems(
        [
          {
            account: "yandex.com.tr · i•••@example.com",
            id: "login-5",
            kind: "login",
          },
        ],
        { allowPayment: false, site: "https://taxi.yandex.ru" }
      ).loginId
    ).toBeUndefined();
  });

  it("lends the Госуслуги login to a public-service site that signs in through it", () => {
    // RU 24.09, d07: mos.ru stopped the doctor's errand at its sign-in, with
    // the Госуслуги login saved.
    const saved = [
      ...entries,
      {
        account: "www.gosuslugi.ru · +7•••76",
        id: "login-esia",
        kind: "login",
      },
    ];

    for (const site of [
      "https://www.mos.ru",
      "https://emias.info",
      "https://lkfl2.nalog.ru",
      "https://my.mosenergosbyt.ru",
    ]) {
      expect(
        selectBrowserVaultItems(saved, { allowPayment: false, site })
      ).toEqual({ gosuslugiLoginId: "login-esia", loginId: undefined });
    }
    // On Госуслуги itself it is the site's own login.
    expect(
      selectBrowserVaultItems(saved, {
        allowPayment: false,
        site: "https://www.gosuslugi.ru",
      })
    ).toEqual({ gosuslugiLoginId: undefined, loginId: "login-esia" });
    // A shop or a bank with the same button never gets it: signing in hands
    // the site the person's Госуслуги profile.
    for (const site of ["https://www.ozon.ru", "https://www.tbank.ru"]) {
      expect(
        selectBrowserVaultItems(saved, { allowPayment: false, site })
          .gosuslugiLoginId
      ).toBeUndefined();
    }
  });

  it("selects the card only when payment was approved for the errand", () => {
    expect(
      selectBrowserVaultItems(entries, {
        allowPayment: true,
        site: "https://taxi.yandex.ru",
      }).paymentId
    ).toBe("card-1");
    expect(
      selectBrowserVaultItems(entries, {
        allowPayment: true,
        site: undefined,
      }).paymentId
    ).toBeUndefined();
  });
});

describe("browser secret bindings", () => {
  it("keeps every secret value inside the run request body", () => {
    const bound = browserSecretBindings({
      card,
      login,
      site: "https://taxi.yandex.ru",
    });

    expect(bound.aliases).toEqual([
      "login_username",
      "login_password",
      "card_number",
      "card_expiry",
      "card_cvc",
      "card_holder",
    ]);
    expect(bound.bindings.map((binding) => binding.source.value)).toContain(
      password
    );
    expect(
      bound.bindings.find((binding) => binding.alias === "card_expiry")?.source
        .value
    ).toBe("04/31");

    const task = composeBrowserTask({
      aliases: bound.aliases,
      allowPayment: true,
      collectImages: false,
      consent: {
        by: "card",
        kind: "confirmed",
        submission: {
          personalData: ["имя", "телефон"],
          kind: "taxi",
          what: "заказ такси домой",
          where: "Яндекс Такси",
          forWhom: "Иван Петров",
        },
      },
      deliveryAddress: undefined,
      errand: "Вызови такси домой",
      facts: "Known details you may type into forms:\nName: Ivan Petrov",
      home: "Moscow, Russia",
      site: "https://taxi.yandex.ru",
    });
    for (const secret of [password, cardNumber, securityCode]) {
      expect(task).not.toContain(secret);
    }
    expect(task).toContain("login_password");
    expect(task).toContain("NEEDS: exactly one of");
    expect(JSON.stringify(bound.aliases)).not.toContain(password);
  });

  it("leads a continuation with the person's own message", () => {
    const bound = browserSecretBindings({
      card,
      login,
      site: "https://taxi.yandex.ru",
    });
    const continuation = composeBrowserContinuation({
      aliases: bound.aliases,
      allowPayment: true,
      collectImages: false,
      consent: { kind: "spend-limit" },
      deliveryAddress: undefined,
      errand: "Войди в аккаунт",
      facts: "Known details you may type into forms:\nPhone: +79991234567",
      message: "Привяжи карту, она есть в сейфе",
      searching: false,
      site: "https://taxi.yandex.ru",
    });

    expect(continuation.startsWith("Привяжи карту, она есть в сейфе")).toBe(
      true
    );
    expect(continuation).toContain("«Войди в аккаунт»");
    expect(continuation).toContain("do not start over");
    expect(continuation).toContain("card_number");
    expect(continuation).toContain("NEEDS: exactly one of");
    for (const secret of [password, cardNumber, securityCode]) {
      expect(continuation).not.toContain(secret);
    }
  });

  it("binds the Госуслуги login to gosuslugi.ru alone, under aliases of its own", () => {
    const esiaPassword = "госуслуги-пароль";
    const bound = browserSecretBindings({
      card: undefined,
      gosuslugiLogin: serializeLoginVaultPayload({
        authentication: { password: esiaPassword, type: "password" },
        identifier: { type: "phone", value: "+79991234567" },
        kind: "login",
        origin: "https://esia.gosuslugi.ru",
        version: 2,
      }),
      login: undefined,
      site: "https://www.mos.ru",
    });

    expect(bound.aliases).toEqual([
      "gosuslugi_username",
      "gosuslugi_phone_digits",
      "gosuslugi_password",
    ]);
    // Typeable on the ESIA sign-in page only, never in mos.ru's own form.
    for (const binding of bound.bindings) {
      expect(binding.allowedDomains).toEqual(["gosuslugi.ru"]);
    }
    expect(
      bound.bindings.find(
        (binding) => binding.alias === "gosuslugi_phone_digits"
      )?.source.value
    ).toBe("9991234567");
    const task = composeBrowserTask({
      aliases: bound.aliases,
      allowPayment: false,
      collectImages: false,
      consent: undefined,
      deliveryAddress: undefined,
      errand: "Передай показания воды",
      facts: undefined,
      home: undefined,
      site: "https://www.mos.ru",
    });
    expect(task).toContain("Войти через Госуслуги");
    expect(task).toContain(
      "gosuslugi_username is a phone number. If the phone field already shows the country code (+7) or a mask, ask for gosuslugi_phone_digits instead — the same number as only the 10 digits after it (no +7, no 8, no spaces); if the site rejects the format, clear the field and try once with the other one, then stop with NEEDS: info describing what the field expects."
    );
    expect(task).not.toContain("9991234567");
    expect(task).not.toContain(esiaPassword);
    expect(task).not.toContain("+79991234567");
  });

  it("binds a phone login also as the 10 digits after +7", () => {
    // RU 25.09, d04: Ozon prefills «+7», and the saved «+7…» login typed
    // over it was rejected as a malformed phone before any code was sent.
    const bound = browserSecretBindings({
      card: undefined,
      login: serializeLoginVaultPayload({
        authentication: { password, type: "password" },
        identifier: { type: "phone", value: "+7 999 123-45-67" },
        kind: "login",
        origin: "https://www.ozon.ru",
        version: 2,
      }),
      site: "https://www.ozon.ru",
    });

    expect(bound.aliases).toEqual([
      "login_username",
      "login_phone_digits",
      "login_password",
    ]);
    const [username, digits] = bound.bindings;
    expect(digits?.source.value).toBe("9991234567");
    expect(digits?.allowedDomains).toEqual(username?.allowedDomains);
    const task = composeBrowserTask({
      aliases: bound.aliases,
      allowPayment: false,
      collectImages: false,
      consent: undefined,
      deliveryAddress: undefined,
      errand: "Закажи тот же корм",
      facts: undefined,
      home: undefined,
      site: "https://www.ozon.ru",
    });
    expect(task).toContain(
      "login_username is a phone number. If the phone field already shows the country code (+7) or a mask, ask for login_phone_digits instead — the same number as only the 10 digits after it (no +7, no 8, no spaces); if the site rejects the format, clear the field and try once with the other one, then stop with NEEDS: info describing what the field expects."
    );
    expect(task).not.toContain("9991234567");
  });

  it("binds an email login as it is", () => {
    const bound = browserSecretBindings({
      card: undefined,
      login,
      site: "https://taxi.yandex.ru",
    });

    expect(bound.aliases).toEqual(["login_username", "login_password"]);
  });

  it("reads a Russian phone as the 10 digits after +7, and no other", () => {
    expect(nationalPhoneDigits("+79991234567")).toBe("9991234567");
    expect(nationalPhoneDigits("8 (999) 123-45-67")).toBe("9991234567");
    expect(nationalPhoneDigits("7 495 123-45-67")).toBe("4951234567");
    for (const foreign of [
      "999 123 45 67",
      "+1 555 123 4567",
      "+44 20 7946 0958",
      "+84 912 345 678",
      "+852 9123 4567",
      "+853 6612 3456",
      "+81 90 1234 5678",
      "+960 791 2345",
      "+961 3 123 456",
      "+7 123 456 78 90",
    ]) {
      expect(nationalPhoneDigits(foreign)).toBeUndefined();
    }
  });

  it("binds the person's phone to the errand's registrable domain alone", () => {
    const bound = browserSecretBindings({
      card: undefined,
      login: undefined,
      signInPhone: "8 (999) 123-45-67",
      site: "https://market.yandex.ru",
    });

    expect(bound.aliases).toEqual(["signin_phone", "signin_phone_digits"]);
    // Yandex signs people in on passport.yandex.ru: the whole of yandex.ru.
    for (const binding of bound.bindings) {
      expect(binding.allowedDomains).toEqual(["yandex.ru"]);
    }
    expect(bound.bindings.map((binding) => binding.source.value)).toEqual([
      "+79991234567",
      "9991234567",
    ]);
  });

  it("binds no phone where a saved login signs in, or on a public suffix", () => {
    expect(
      browserSecretBindings({
        card: undefined,
        login,
        signInPhone: "+79991234567",
        site: "https://taxi.yandex.ru",
      }).aliases
    ).toEqual(["login_username", "login_password"]);
    expect(
      browserSecretBindings({
        card: undefined,
        login: undefined,
        signInPhone: "+79991234567",
        site: "https://spb.ru",
      }).aliases
    ).toEqual([]);
    expect(
      browserSecretBindings({
        card: undefined,
        login: undefined,
        signInPhone: "+852 9123 4567",
        site: "https://www.ozon.ru",
      }).bindings.map((binding) => binding.source.value)
    ).toEqual(["+852 9123 4567"]);
  });

  it("binds nothing when no vault item was selected", () => {
    const bound = browserSecretBindings({
      card: undefined,
      login: undefined,
      site: "https://taxi.yandex.ru",
    });

    expect(bound.bindings).toEqual([]);
    expect(
      composeBrowserTask({
        aliases: bound.aliases,
        allowPayment: false,
        collectImages: false,
        consent: undefined,
        deliveryAddress: undefined,
        errand: "Order groceries",
        facts: undefined,
        home: undefined,
        site: undefined,
      })
    ).toContain("No stored credentials are available");
  });
});

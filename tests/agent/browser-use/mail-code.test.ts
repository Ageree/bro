import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  authenticatedFrom,
  codeInLetter,
  mailCodeFromSite,
  waitsForMailCode,
} from "@agent/lib/browser-use/mail-code";
import { accessScopeForUser } from "@shared/identity/access-scope";
import { type FakeComposio, fakeComposio } from "@tests/helpers/composio";

vi.mock("@db/services/settings", () => ({
  getGoogleWorkspaceAccess: async () => "full",
}));

const scope = accessScopeForUser("better-auth:user-1");

/** What Gmail stamps on a letter the domain really sent. */
function passed(domain: string) {
  return `mx.google.com;\r\n       dkim=pass header.i=@${domain} header.s=mail header.b=abc;\r\n       spf=pass (google.com: domain of noreply@${domain} designates 192.0.2.1 as permitted sender) smtp.mailfrom=noreply@${domain};\r\n       dmarc=pass (p=REJECT sp=REJECT dis=NONE) header.from=${domain}`;
}

interface Letter {
  readonly authenticationResults?: readonly string[];
  readonly from: string;
  readonly id: string;
  readonly receivedAt: Date;
  readonly subject: string;
  readonly text: string;
}

/** A mailbox behind the Composio proxy, as Gmail's REST API answers it. */
function mailbox(composio: FakeComposio, letters: readonly Letter[]) {
  composio.proxy.mockImplementation(({ url }) => {
    if (url.pathname.endsWith("/messages")) {
      return {
        data: { messages: letters.map((letter) => ({ id: letter.id })) },
      };
    }
    const id = decodeURIComponent(url.pathname.split("/").at(-1) ?? "");
    const letter = letters.find((item) => item.id === id);
    if (!letter) return { status: 404 };
    return {
      data: {
        id: letter.id,
        internalDate: String(letter.receivedAt.getTime()),
        payload: {
          body: { data: Buffer.from(letter.text).toString("base64url") },
          headers: [
            ...(letter.authenticationResults ?? []).map((value) => ({
              name: "Authentication-Results",
              value,
            })),
            { name: "From", value: letter.from },
            { name: "Subject", value: letter.subject },
          ],
          mimeType: "text/plain",
        },
      },
    };
  });
}

function look(site: string | null = "https://www.ozon.ru") {
  return mailCodeFromSite(scope, {
    signal: new AbortController().signal,
    since: new Date(Date.now() - 60_000),
    site,
    waitMs: 0,
  });
}

describe("the code a site's letter carries", () => {
  it("takes the number a word for a code leads", () => {
    expect(
      codeInLetter(
        "Код для входа в Ozon",
        "Здравствуйте! Ваш код для входа: 482913. Никому его не сообщайте. Заказ № 48213 уже в пути."
      )
    ).toBe("482913");
    expect(codeInLetter("Your verification code", "Your code is 7392")).toBe(
      "7392"
    );
    expect(codeInLetter("Код подтверждения", "Код: 482 913")).toBe("482913");
    // HTML letters space the groups with a no-break space.
    expect(codeInLetter("Код подтверждения", "Код: 482 913")).toBe("482913");
    // A support phone after the code is no second code.
    expect(
      codeInLetter(
        "Код для входа",
        "Ваш код: 482913. Если это были не вы, позвоните: 8 800 234-48-08 или +7 (495) 123-45-67"
      )
    ).toBe("482913");
  });

  it("takes the one number of a letter about a code", () => {
    expect(
      codeInLetter("Подтверждение входа", "Введите на сайте код\n\n482913")
    ).toBe("482913");
  });

  it("gives no code when it is not plain which number that is", () => {
    // Two different codes.
    expect(
      codeInLetter("Коды", "Код для входа: 482913. Код для оплаты: 551204.")
    ).toBeUndefined();
    // A letter that is not about a code.
    expect(
      codeInLetter("Ваш заказ", "Заказ 48213 доставят завтра, сумма 1 590 ₽")
    ).toBeUndefined();
    // A year, an amount and an order number are not codes.
    expect(
      codeInLetter("Код", "© 2026 Ozon. Скидка 1500 ₽ на заказ № 482913")
    ).toBeUndefined();
  });
});

describe("Gmail's word on who sent a letter", () => {
  it("trusts a DMARC or DKIM pass of the site's domain", () => {
    expect(authenticatedFrom([passed("ozon.ru")], "ozon.ru")).toBe(true);
    expect(
      authenticatedFrom(
        ["mx.google.com; dkim=pass header.i=@sender.ozon.ru; dmarc=none"],
        "ozon.ru"
      )
    ).toBe(true);
  });

  it("trusts nothing else", () => {
    // Another domain that only ends the same way.
    expect(authenticatedFrom([passed("notozon.ru")], "ozon.ru")).toBe(false);
    // A pass of the sending service's own domain, not the site's.
    expect(
      authenticatedFrom(
        [
          "mx.google.com; dkim=pass header.i=@mailer.example; spf=pass smtp.mailfrom=bounce@mailer.example; dmarc=fail header.from=ozon.ru",
        ],
        "ozon.ru"
      )
    ).toBe(false);
    // A pass line the sender wrote below Gmail's own stamp.
    expect(
      authenticatedFrom(
        [
          "mx.google.com; dkim=fail header.i=@ozon.ru; dmarc=fail header.from=ozon.ru",
          passed("ozon.ru"),
        ],
        "ozon.ru"
      )
    ).toBe(false);
    expect(authenticatedFrom([], "ozon.ru")).toBe(false);
  });
});

describe("a run that stopped for a code by email", () => {
  it("is one that says so, or whose Details point at an email", () => {
    expect(waitsForMailCode("email_code", "Needs: email_code")).toBe(true);
    expect(
      waitsForMailCode(
        "sms_code",
        "Needs: sms_code\nDetails: ввести код из письма, отправленного на `n******6@gmail.com`"
      )
    ).toBe(true);
    expect(
      waitsForMailCode(
        "sms_code",
        "Needs: sms_code\nDetails: код из SMS на `+****** ***-**-76`"
      )
    ).toBe(false);
    expect(waitsForMailCode("decision", "Needs: decision")).toBe(false);
  });
});

describe("taking the code from the person's mailbox", () => {
  let composio: FakeComposio;

  beforeEach(() => {
    composio = fakeComposio();
  });

  it("finds the code in the site's own letter", async () => {
    composio.connect({ toolkit: "googlesuper" });
    mailbox(composio, [
      {
        authenticationResults: [passed("ozon.ru")],
        from: "Ozon <noreply@sender.ozon.ru>",
        id: "letter-1",
        receivedAt: new Date(),
        subject: "Код для входа в Ozon",
        text: "Ваш код для входа: 482913",
      },
    ]);

    await expect(look()).resolves.toMatchObject({
      code: "482913",
      domain: "ozon.ru",
      kind: "found",
    });
    const search = composio.proxy.mock.calls[0]?.[0].url;
    expect(search?.searchParams.get("q")).toMatch(
      /^from:ozon\.ru in:anywhere after:\d+$/u
    );
  });

  it("never takes a code from anyone else's letter", async () => {
    composio.connect({ toolkit: "googlesuper" });
    mailbox(composio, [
      {
        // A letter that only claims to come from the site.
        authenticationResults: [
          "mx.google.com; dkim=fail header.i=@ozon.ru; dmarc=fail header.from=ozon.ru",
        ],
        from: "Ozon <noreply@ozon.ru>",
        id: "spoofed",
        receivedAt: new Date(),
        subject: "Код для входа",
        text: "Ваш код: 111111",
      },
      {
        authenticationResults: [passed("ozon-security.com")],
        from: "Ozon Security <code@ozon-security.com>",
        id: "lookalike",
        receivedAt: new Date(),
        subject: "Код для входа",
        text: "Ваш код: 222222",
      },
    ]);

    await expect(look()).resolves.toEqual({
      domain: "ozon.ru",
      kind: "not_found",
    });
  });

  it("never takes a code sent before the run asked for it", async () => {
    composio.connect({ toolkit: "googlesuper" });
    mailbox(composio, [
      {
        authenticationResults: [passed("ozon.ru")],
        from: "noreply@ozon.ru",
        id: "old",
        receivedAt: new Date(Date.now() - 5 * 60_000),
        subject: "Код для входа",
        text: "Ваш код: 482913",
      },
    ]);

    await expect(look()).resolves.toEqual({
      domain: "ozon.ru",
      kind: "not_found",
    });
  });

  it("says so when the person's Gmail is not connected", async () => {
    await expect(look()).resolves.toEqual({
      domain: "ozon.ru",
      kind: "not_connected",
    });
    expect(composio.proxy).not.toHaveBeenCalled();
  });

  it("looks for nothing without the errand's own site", async () => {
    composio.connect({ toolkit: "googlesuper" });

    await expect(look(null)).resolves.toEqual({ kind: "no_site" });
    expect(composio.proxy).not.toHaveBeenCalled();
  });
});

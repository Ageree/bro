import { beforeEach, describe, expect, it, vi } from "vitest";
import type { getGoogleWorkspaceAccess } from "@db/services/settings";
import {
  composioToolContext,
  type FakeComposio,
  fakeComposio,
} from "@tests/helpers/composio";

const settings = vi.hoisted(() => ({
  access: vi.fn<typeof getGoogleWorkspaceAccess>(),
}));

vi.mock("@db/services/settings", () => ({
  getGoogleWorkspaceAccess: settings.access,
}));

import {
  dateHeaderOffset,
  headerAddress,
  readGmailThread,
  voiceSample,
} from "@agent/lib/google-workspace/gmail";

describe("the person's voice in a sent email", () => {
  it("takes the greeting and sign-off around their own words", () => {
    expect(
      voiceSample(
        "Ирина Павловна, добрый день!\n\nОтчёт пришлю до 8-го, раньше не получится.\n\nСпасибо! Хорошего дня."
      )
    ).toEqual({
      greeting: "Ирина Павловна, добрый день!",
      signOff: "Спасибо! Хорошего дня.",
      text: "Ирина Павловна, добрый день!\n\nОтчёт пришлю до 8-го, раньше не получится.\n\nСпасибо! Хорошего дня.",
    });
  });

  it("keeps a two-line sign-off together and leaves the quote out", () => {
    const sample = voiceSample(
      "Hey Sam,\n\nTuesday works.\n\nBest,\nAlex\n\nOn Mon, Sep 21, 2026 at 10:00 AM Sam Carter <sam@example.com> wrote:\n> Could we meet?"
    );
    expect(sample.greeting).toBe("Hey Sam,");
    expect(sample.signOff).toBe("Best,\nAlex");
    expect(sample.text).not.toContain("Could we meet");
  });

  it("stops at Gmail's Russian attribution line and at a signature", () => {
    expect(
      voiceSample(
        "Привет!\n\nОк, давай в пятницу.\n\nчт, 24 сент. 2026 г. в 16:40, Ирина <irina@example.com>:\n> Встретимся?"
      ).text
    ).toBe("Привет!\n\nОк, давай в пятницу.");
    expect(
      voiceSample("Коротко: да.\n--\nАлексей\n+7 900 000-00-00").signOff
    ).toBeNull();
  });

  it("names no formula in a letter that is one long paragraph", () => {
    const sample = voiceSample(
      "Отправляю обновлённую версию договора: сроки поправили, остальное без изменений, если будут вопросы, пишите."
    );
    expect(sample.greeting).toBeNull();
    expect(sample.signOff).toBeNull();
  });

  it("reads the addressee and the sender's clock from headers", () => {
    expect(headerAddress("Ирина Павловна <Tester+Irina@Example.com>")).toBe(
      "tester+irina@example.com"
    );
    expect(headerAddress("sam@example.com, alex@example.com")).toBe(
      "sam@example.com"
    );
    expect(dateHeaderOffset("Wed, 23 Sep 2026 16:40:00 +0500")).toBe("+05:00");
    expect(dateHeaderOffset("Wed, 23 Sep 2026 16:40:00 -0700 (PDT)")).toBe(
      "-07:00"
    );
    // UTC and «unknown» stamps say nothing about the sender: Microsoft 365
    // and relays write them whatever the sender's zone.
    expect(dateHeaderOffset("Wed, 23 Sep 2026 13:40:00 GMT")).toBeNull();
    expect(dateHeaderOffset("Wed, 23 Sep 2026 13:40:00 +0000")).toBeNull();
    expect(dateHeaderOffset("Wed, 23 Sep 2026 13:40:00 -0000")).toBeNull();
    expect(dateHeaderOffset(null)).toBeNull();
  });
});

const mailbox = "/gmail/v1/users/me";

function message(
  id: string,
  options: {
    readonly body: string;
    readonly date: string;
    readonly from: string;
    readonly labels: readonly string[];
    readonly subject: string;
    readonly to: string;
  }
) {
  return {
    id,
    labelIds: options.labels,
    payload: {
      body: { data: Buffer.from(options.body).toString("base64url") },
      headers: [
        { name: "From", value: options.from },
        { name: "To", value: options.to },
        { name: "Subject", value: options.subject },
        { name: "Date", value: options.date },
      ],
      mimeType: "text/plain",
    },
    threadId: "thread-thursday",
  };
}

const irina = "Ирина Павловна Кузнецова <tester+irina@example.com>";

const thursday = message("m-thursday", {
  body: "Добрый день!\n\nПредлагаю встретиться в четверг в 13:00 по Екатеринбургу.\n\nВам удобно?",
  date: "Wed, 23 Sep 2026 16:40:00 +0500",
  from: irina,
  labels: ["INBOX", "UNREAD"],
  subject: "Встреча в четверг",
  to: "tester@example.com",
});

const sentToIrina = message("m-report", {
  body: "Ирина Павловна, добрый день!\n\nОтчёт готов и лежит в общей папке.\n\nСпасибо! Хорошего дня.",
  date: "Fri, 4 Sep 2026 18:30:00 +0300",
  from: "tester@example.com",
  labels: ["SENT"],
  subject: "Отчёт готов",
  to: irina,
});

let composio: FakeComposio;
let sentQueries: string[];

beforeEach(() => {
  vi.clearAllMocks();
  settings.access.mockResolvedValue("full");
  composio = fakeComposio();
  composio.connect({ id: "ca_google", toolkit: "googlesuper" });
  sentQueries = [];
});

/** Gmail with Irina's thread and, when `sent` holds any, the person's sent mail. */
function serveMailbox(sent: Readonly<Record<string, readonly string[]>>) {
  composio.proxy.mockImplementation(({ url }) => {
    const path = url.pathname.slice(mailbox.length);
    if (path === "/threads/thread-thursday") {
      return { data: { id: "thread-thursday", messages: [thursday] } };
    }
    if (path === "/messages") {
      const query = url.searchParams.get("q") ?? "";
      sentQueries.push(query);
      return {
        data: { messages: (sent[query] ?? []).map((id) => ({ id })) },
      };
    }
    if (path === "/messages/m-report") return { data: sentToIrina };
    return { data: { error: { message: "Not Found" } }, status: 404 };
  });
}

describe("a thread read for a reply", () => {
  it("brings the person's own emails to the other side, and their clock", async () => {
    serveMailbox({ 'in:sent to:"tester+irina@example.com"': ["m-report"] });

    const thread = await readGmailThread(
      composioToolContext("ca_google"),
      "thread-thursday",
      { voice: { known: [], left: 3 } }
    );

    expect(thread.messages[0]).toMatchObject({
      senderUtcOffset: "+05:00",
      sentByYou: false,
    });
    expect("yourEarlierEmails" in thread && thread.yourEarlierEmails).toEqual({
      emails: [
        {
          date: "Fri, 4 Sep 2026 18:30:00 +0300",
          greeting: "Ирина Павловна, добрый день!",
          signOff: "Спасибо! Хорошего дня.",
          subject: "Отчёт готов",
          text: "Ирина Павловна, добрый день!\n\nОтчёт готов и лежит в общей папке.\n\nСпасибо! Хорошего дня.",
          to: irina,
        },
      ],
      sameAddressee: true,
      to: "tester+irina@example.com",
    });
    expect(sentQueries).toEqual(['in:sent to:"tester+irina@example.com"']);
  });

  it("falls back to the person's latest sent mail, marked as such", async () => {
    serveMailbox({ "in:sent": ["m-report"] });

    const thread = await readGmailThread(
      composioToolContext("ca_google"),
      "thread-thursday",
      { voice: { known: [], left: 3 } }
    );

    expect(sentQueries).toEqual([
      'in:sent to:"tester+irina@example.com"',
      "in:sent",
    ]);
    expect(
      "yourEarlierEmails" in thread && thread.yourEarlierEmails
    ).toMatchObject({
      emails: [expect.objectContaining({ subject: "Отчёт готов" })],
      sameAddressee: false,
    });
  });

  it("still reads the thread when the sent mail cannot be searched", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    composio.proxy.mockImplementation(({ url }) =>
      url.pathname.endsWith("/threads/thread-thursday")
        ? { data: { id: "thread-thursday", messages: [thursday] } }
        : { data: { error: { message: "Invalid query" } }, status: 400 }
    );

    const thread = await readGmailThread(
      composioToolContext("ca_google"),
      "thread-thursday",
      { voice: { known: [], left: 3 } }
    );

    expect(thread.messages).toHaveLength(1);
    expect("yourEarlierEmails" in thread).toBe(false);
  });

  it("looks up an addressee's voice once a turn, and no more than the turn allows", async () => {
    serveMailbox({ 'in:sent to:"tester+irina@example.com"': ["m-report"] });

    const known = await readGmailThread(
      composioToolContext("ca_google"),
      "thread-thursday",
      { voice: { known: ["tester+irina@example.com"], left: 2 } }
    );
    expect("yourEarlierEmails" in known && known.yourEarlierEmails).toEqual({
      alreadyAbove: true,
      to: "tester+irina@example.com",
    });
    const spent = await readGmailThread(
      composioToolContext("ca_google"),
      "thread-thursday",
      { voice: { known: [], left: 0 } }
    );
    expect("yourEarlierEmails" in spent).toBe(false);
    expect(sentQueries).toEqual([]);
  });

  it("brings no voice for a letter from a robot or a mailing", async () => {
    serveMailbox({ 'in:sent to:"tester+irina@example.com"': ["m-report"] });
    thursday.payload.headers.push({
      name: "List-Unsubscribe",
      value: "<https://example.com/unsubscribe>",
    });

    try {
      const thread = await readGmailThread(
        composioToolContext("ca_google"),
        "thread-thursday",
        { voice: { known: [], left: 3 } }
      );
      expect("yourEarlierEmails" in thread).toBe(false);
      expect(sentQueries).toEqual([]);
    } finally {
      thursday.payload.headers.pop();
    }
  });

  it("asks nothing more of Gmail for a plain read", async () => {
    serveMailbox({});

    const thread = await readGmailThread(
      composioToolContext("ca_google"),
      "thread-thursday"
    );

    expect("yourEarlierEmails" in thread).toBe(false);
    expect(composio.proxy).toHaveBeenCalledOnce();
  });
});

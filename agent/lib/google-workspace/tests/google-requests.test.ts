import { createHash } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import type { getGoogleWorkspaceAccess } from "@db/services/settings";
import {
  composioToolContext,
  type FakeComposio,
  fakeComposio,
  type ProxiedAnswer,
  type ProxiedRequest,
} from "@tests/helpers/composio";

const settings = vi.hoisted(() => ({
  access: vi.fn<typeof getGoogleWorkspaceAccess>(),
}));

vi.mock("@db/services/settings", () => ({
  getGoogleWorkspaceAccess: settings.access,
}));

import {
  createCalendarEvent,
  deleteCalendarEvent,
  updateCalendarEvent,
} from "@agent/lib/google-workspace/calendar";
import {
  GoogleApiError,
  withGoogleAuth,
} from "@agent/lib/google-workspace/client";
import { searchGoogleContacts } from "@agent/lib/google-workspace/contacts";
import { draftGmail, sendGmail } from "@agent/lib/google-workspace/gmail";

const mailbox = "https://gmail.googleapis.com/gmail/v1/users/me";
const calendarApi = "https://www.googleapis.com/calendar/v3";

let composio: FakeComposio;

beforeEach(() => {
  settings.access.mockResolvedValue("full");
  composio = fakeComposio();
  composio.connect({ id: "ca_google", toolkit: "googlesuper" });
  composio.connect({
    authConfigId: "ac_google_read_only",
    id: "ca_google_read",
    toolkit: "googlesuper",
  });
});

afterEach(() => {
  vi.clearAllMocks();
});

/** Answers each proxied request by its method and URL without the query. */
function answer(
  routes: Record<string, ProxiedAnswer | ProxiedAnswer[]>
): (request: ProxiedRequest) => ProxiedAnswer {
  const served = new Map<string, number>();
  return (request) => {
    const key = `${request.method} ${request.url.origin}${request.url.pathname}`;
    const route = routes[key];
    if (!route) throw new Error(`No fake route for ${key}`);
    const index = served.get(key) ?? 0;
    served.set(key, index + 1);
    return Array.isArray(route) ? (route[index] ?? route.at(-1) ?? {}) : route;
  };
}

function requestTo(method: string, url: string) {
  return composio.proxy.mock.calls
    .map(([request]) => request)
    .find(
      (request) =>
        request.method === method &&
        `${request.url.origin}${request.url.pathname}` === url
    );
}

const rawBodySchema = z.object({
  raw: z.string(),
  threadId: z.string().optional(),
});

function rawHeaders(raw: string | undefined) {
  const message = Buffer.from(raw ?? "", "base64url").toString("utf8");
  return message.slice(0, message.indexOf("\r\n\r\n"));
}

function stableMessageId() {
  const stableId = createHash("sha256")
    .update("session-1:call-1")
    .digest("hex")
    .slice(0, 48);
  return `<openinstinct-${stableId}@local>`;
}

/** The RANEPA message a reply answers, as Gmail's metadata read returns it. */
const answeredMessage: ProxiedAnswer = {
  data: {
    id: "gmail-message-1",
    payload: {
      headers: [
        { name: "Message-Id", value: "<question@ranepa.ru>" },
        { name: "References", value: "<start@ranepa.ru>" },
        { name: "Subject", value: "Собеседование" },
      ],
    },
    threadId: "thread-ranepa",
  },
};

describe("Google requests through Composio", () => {
  it("uses the read-only level's account under its own key", async () => {
    settings.access.mockResolvedValue("full");
    const full = composioToolContext("ca_google");
    await withGoogleAuth(full, async () => "read");
    settings.access.mockResolvedValue("read_only");
    const readOnly = composioToolContext("ca_google_read");
    composio.proxy.mockResolvedValue({ data: {}, status: 401 });

    await expect(
      withGoogleAuth(readOnly, async (google) =>
        google.json(z.unknown(), { url: `${mailbox}/profile` })
      )
    ).rejects.toThrow("authorization required");

    const readOnlyProvider = readOnly.getToken.mock.calls[0]?.[0];
    expect(readOnlyProvider).toBeDefined();
    expect(readOnlyProvider).not.toBe(full.getToken.mock.calls[0]?.[0]);
    expect(full.getToken.mock.calls[0]?.[1]).toEqual({
      authKey: "google-workspace",
    });
    expect(readOnly.getToken.mock.calls[0]?.[1]).toEqual({
      authKey: "google-workspace-read-only",
    });
    expect(readOnly.requireAuth).toHaveBeenCalledExactlyOnceWith(
      readOnlyProvider,
      { authKey: "google-workspace-read-only" }
    );
    expect(composio.proxy.mock.calls[0]?.[0].connectedAccountId).toBe(
      "ca_google_read"
    );
  });

  it("sends an email with a stable retry-safe message ID", async () => {
    composio.proxy.mockImplementation(
      answer({
        [`POST ${mailbox}/messages/send`]: {
          data: { id: "sent-1", threadId: "thread-1" },
        },
      })
    );

    await expect(
      sendGmail(composioToolContext("ca_google"), {
        bcc: [],
        body: "Hello",
        cc: [],
        subject: "Status",
        to: ["person@example.com"],
      })
    ).resolves.toEqual({ id: "sent-1", threadId: "thread-1" });

    const raw = Buffer.from(
      [
        "To: person@example.com",
        "Subject: Status",
        `Message-ID: ${stableMessageId()}`,
        "MIME-Version: 1.0",
        'Content-Type: text/plain; charset="UTF-8"',
        "Content-Transfer-Encoding: base64",
      ].join("\r\n") + `\r\n\r\n${Buffer.from("Hello").toString("base64")}`,
      "utf8"
    ).toString("base64url");
    expect(requestTo("POST", `${mailbox}/messages/send`)?.body).toEqual({
      raw,
    });
  });

  it("sends a reply into the answered message's thread", async () => {
    composio.proxy.mockImplementation(
      answer({
        [`GET ${mailbox}/messages/gmail-message-1`]: answeredMessage,
        [`POST ${mailbox}/messages/send`]: {
          data: { id: "sent-1", threadId: "thread-ranepa" },
        },
      })
    );

    await sendGmail(composioToolContext("ca_google"), {
      bcc: [],
      body: "Подойдёт вторник в 11:00 или среда в 15:00.",
      cc: [],
      replyToMessageId: "gmail-message-1",
      to: ["admissions@ranepa.ru"],
    });

    const read = requestTo("GET", `${mailbox}/messages/gmail-message-1`);
    expect(read?.url.searchParams.get("format")).toBe("metadata");
    expect(read?.url.searchParams.getAll("metadataHeaders")).toEqual([
      "Message-ID",
      "References",
      "In-Reply-To",
      "Subject",
    ]);
    const sent = rawBodySchema.parse(
      requestTo("POST", `${mailbox}/messages/send`)?.body
    );
    expect(sent.threadId).toBe("thread-ranepa");
    const headers = rawHeaders(sent.raw);
    expect(headers).toContain("To: admissions@ranepa.ru");
    expect(headers).toContain("In-Reply-To: <question@ranepa.ru>");
    expect(headers).toContain(
      "References: <start@ranepa.ru>\r\n <question@ranepa.ru>"
    );
    expect(headers).toContain(
      `Subject: =?UTF-8?B?${Buffer.from("Re: Собеседование").toString("base64")}?=`
    );
  });

  it("saves a reply draft in the answered message's thread", async () => {
    composio.proxy.mockImplementation(
      answer({
        [`GET ${mailbox}/messages/gmail-message-1`]: answeredMessage,
        [`POST ${mailbox}/drafts`]: {
          data: {
            id: "draft-1",
            message: { id: "draft-message-1", threadId: "thread-ranepa" },
          },
        },
      })
    );

    await expect(
      draftGmail(composioToolContext("ca_google"), {
        bcc: [],
        body: "Черновик ответа",
        cc: [],
        replyToMessageId: "gmail-message-1",
        to: ["admissions@ranepa.ru"],
      })
    ).resolves.toMatchObject({ id: "draft-1" });

    const draft = z
      .object({ message: rawBodySchema })
      .parse(requestTo("POST", `${mailbox}/drafts`)?.body);
    expect(draft.message.threadId).toBe("thread-ranepa");
    expect(rawHeaders(draft.message.raw)).toContain(
      "In-Reply-To: <question@ranepa.ru>"
    );
  });

  it("sends a reply only into the thread its card named", async () => {
    composio.proxy.mockImplementation(
      answer({
        [`GET ${mailbox}/messages/gmail-message-1`]: answeredMessage,
        [`POST ${mailbox}/messages/send`]: {
          data: { id: "sent-1", threadId: "thread-ranepa" },
        },
      })
    );
    const reply = {
      bcc: [],
      body: "Подойдёт вторник в 11:00.",
      cc: [],
      replyToMessageId: "gmail-message-1",
      to: ["admissions@ranepa.ru"],
    };

    // The card said «Счёт за сентябрь»; the message is in «Собеседование».
    await expect(
      sendGmail(composioToolContext("ca_google"), {
        ...reply,
        subject: "Счёт за сентябрь",
      })
    ).rejects.toThrow(/Nothing sent.*«Собеседование»/u);
    expect(requestTo("POST", `${mailbox}/messages/send`)).toBeUndefined();

    await expect(
      sendGmail(composioToolContext("ca_google"), {
        ...reply,
        subject: "Re: «Собеседование»",
      })
    ).resolves.toMatchObject({ id: "sent-1" });
  });

  it("recovers a duplicate Calendar insert using the stable event ID", async () => {
    const eventId = createHash("sha256")
      .update("session-1:call-1")
      .digest("hex")
      .slice(0, 32);
    composio.proxy.mockImplementation(
      answer({
        [`GET ${calendarApi}/calendars/primary/events/${eventId}`]: {
          data: { id: "existing-event", summary: "Planning" },
        },
        [`POST ${calendarApi}/calendars/primary/events`]: {
          data: {
            error: {
              code: 409,
              message: "The requested identifier already exists.",
            },
          },
          status: 409,
        },
      })
    );

    await expect(
      createCalendarEvent(composioToolContext("ca_google"), {
        attendees: ["person@example.com"],
        calendarId: "primary",
        end: "2026-08-28T11:00:00-04:00",
        start: "2026-08-28T10:00:00-04:00",
        summary: "Planning",
        timezone: "America/New_York",
      })
    ).resolves.toEqual({ id: "existing-event", summary: "Planning" });

    const insert = requestTo("POST", `${calendarApi}/calendars/primary/events`);
    expect(insert?.url.searchParams.get("sendUpdates")).toBe("all");
    expect(insert?.body).toMatchObject({
      id: eventId,
      status: "confirmed",
      visibility: "private",
    });
  });

  it("moves a Calendar event in place and tells its attendees", async () => {
    composio.proxy.mockImplementation(
      answer({
        [`GET ${calendarApi}/calendars/primary/events/event-1`]: {
          data: { id: "event-1", summary: "Созвон с командой" },
        },
        [`PATCH ${calendarApi}/calendars/primary/events/event-1`]: {
          data: { id: "event-1" },
        },
      })
    );

    await expect(
      updateCalendarEvent(composioToolContext("ca_google"), {
        calendarId: "primary",
        end: "2026-09-25T11:00:00+03:00",
        eventId: "event-1",
        eventTitle: "Созвон",
        start: "2026-09-25T10:00:00+03:00",
        timezone: "Europe/Moscow",
      })
    ).resolves.toEqual({ id: "event-1" });

    const patch = requestTo(
      "PATCH",
      `${calendarApi}/calendars/primary/events/event-1`
    );
    expect(patch?.url.searchParams.get("sendUpdates")).toBe("all");
    // Fields left out stay as they are: only the time goes to Google.
    expect(patch?.body).toEqual({
      end: {
        dateTime: "2026-09-25T11:00:00+03:00",
        timeZone: "Europe/Moscow",
      },
      start: {
        dateTime: "2026-09-25T10:00:00+03:00",
        timeZone: "Europe/Moscow",
      },
    });
  });

  it("deletes a Calendar event and treats one already gone as deleted", async () => {
    composio.proxy.mockImplementation(
      answer({
        [`DELETE ${calendarApi}/calendars/primary/events/event-1`]: [
          { data: null, status: 204 },
          {
            data: { error: { message: "Resource has been deleted" } },
            status: 410,
          },
          { data: { error: { message: "Forbidden" } }, status: 403 },
        ],
        [`GET ${calendarApi}/calendars/primary/events/event-1`]: {
          data: { id: "event-1", summary: "Тестовое событие" },
        },
      })
    );
    const ctx = composioToolContext("ca_google");
    const input = {
      calendarId: "primary",
      eventId: "event-1",
      eventTitle: "Тестовое событие",
    };

    await expect(deleteCalendarEvent(ctx, input)).resolves.toEqual({
      alreadyDeleted: false,
    });
    await expect(deleteCalendarEvent(ctx, input)).resolves.toEqual({
      alreadyDeleted: true,
    });
    await expect(deleteCalendarEvent(ctx, input)).rejects.toBeInstanceOf(
      GoogleApiError
    );
    expect(
      requestTo(
        "DELETE",
        `${calendarApi}/calendars/primary/events/event-1`
      )?.url.searchParams.get("sendUpdates")
    ).toBe("all");
  });

  it("warms the People search cache before the contact query", async () => {
    settings.access.mockResolvedValue("read_only");
    composio.proxy.mockResolvedValueOnce({ data: {} }).mockResolvedValueOnce({
      data: { results: [{ person: { resourceName: "people/1" } }] },
    });

    await expect(
      searchGoogleContacts(composioToolContext("ca_google_read"), "Person", 10)
    ).resolves.toEqual({
      contacts: [{ person: { resourceName: "people/1" } }],
    });

    const [warm, search] = composio.proxy.mock.calls.map(
      ([request]) => request.url
    );
    expect(warm?.toString()).toBe(
      "https://people.googleapis.com/v1/people:searchContacts?query=&readMask=names%2CemailAddresses%2CphoneNumbers%2Corganizations"
    );
    expect(search?.searchParams.get("query")).toBe("Person");
    expect(search?.searchParams.get("pageSize")).toBe("10");
  });
});

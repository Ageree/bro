import { createHash } from "node:crypto";
import * as CalendarApi from "@googleapis/calendar";
import * as GmailApi from "@googleapis/gmail";
import * as PeopleApi from "@googleapis/people";
import type { ToolContext } from "eve/tools";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { getGoogleWorkspaceAccess } from "@db/services/settings";
import { accessScopeForUser } from "@shared/identity/access-scope";

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
import { withGoogleAuth } from "@agent/lib/google-workspace/client";
import { searchGoogleContacts } from "@agent/lib/google-workspace/contacts";
import { draftGmail, sendGmail } from "@agent/lib/google-workspace/gmail";

interface RequestOptions {
  signal: AbortSignal;
}

const calendarMock = vi.spyOn(CalendarApi, "calendar");
const gmailMock = vi.spyOn(GmailApi, "gmail");
const peopleMock = vi.spyOn(PeopleApi, "people");
const setCredentialsMock = vi.spyOn(
  GmailApi.auth.OAuth2.prototype,
  "setCredentials"
);

const scope = accessScopeForUser("better-auth:user-1");

afterEach(() => {
  vi.clearAllMocks();
  // Each test builds its own client: the next one must not get this one back.
  for (const factory of [calendarMock, gmailMock, peopleMock]) {
    factory.mockReset();
  }
});

describe("generated Google Workspace clients", () => {
  it("hands the Connect token to Google and requests reauthorization on 401", async () => {
    settings.access.mockResolvedValue("full");
    const ctx = toolContext();
    const error = new GoogleApiError(401);

    await expect(withGoogleAuth(ctx, () => Promise.reject(error))).rejects.toBe(
      error
    );

    expect(settings.access).toHaveBeenCalledExactlyOnceWith(scope);
    expect(ctx.getToken).toHaveBeenCalledOnce();
    expect(ctx.getToken.mock.calls[0]?.[1]).toBeUndefined();
    expect(setCredentialsMock).toHaveBeenCalledWith({
      access_token: "google-access-token",
    });
    expect(ctx.requireAuth).toHaveBeenCalledOnce();
    expect(ctx.requireAuth.mock.calls[0]?.[0]).toBe(
      ctx.getToken.mock.calls[0]?.[0]
    );
  });

  it("asks a read-only workspace's grant for read scopes under its own key", async () => {
    settings.access.mockResolvedValue("full");
    const full = toolContext();
    await withGoogleAuth(full, async () => "read");
    settings.access.mockResolvedValue("read_only");
    const readOnly = toolContext();
    const error = new GoogleApiError(401);

    await expect(
      withGoogleAuth(readOnly, () => Promise.reject(error))
    ).rejects.toBe(error);

    const readOnlyProvider = readOnly.getToken.mock.calls[0]?.[0];
    expect(readOnlyProvider).toBeDefined();
    expect(readOnlyProvider).not.toBe(full.getToken.mock.calls[0]?.[0]);
    expect(readOnly.getToken.mock.calls[0]?.[1]).toEqual({
      authKey: "google-workspace-read-only",
    });
    expect(readOnly.requireAuth).toHaveBeenCalledExactlyOnceWith(
      readOnlyProvider,
      { authKey: "google-workspace-read-only" }
    );
  });

  it("sends typed Gmail requests with a stable retry-safe message ID", async () => {
    settings.access.mockResolvedValue("full");
    const ctx = toolContext();
    const client = GmailApi.gmail({ version: "v1" });
    const send = gmailSendMock();
    Object.defineProperty(client.users.messages, "send", { value: send });
    googleClients({ gmail: client });

    await sendGmail(ctx, {
      bcc: [],
      body: "Hello",
      cc: [],
      subject: "Status",
      to: ["person@example.com"],
    });

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
    expect(send).toHaveBeenCalledWith(
      { requestBody: { raw }, userId: "me" },
      { signal: ctx.abortSignal }
    );
  });

  it("sends a reply into the answered message's thread", async () => {
    settings.access.mockResolvedValue("full");
    const ctx = toolContext();
    const client = GmailApi.gmail({ version: "v1" });
    const get = answeredMessageMock();
    const send = gmailSendMock();
    Object.defineProperty(client.users.messages, "get", { value: get });
    Object.defineProperty(client.users.messages, "send", { value: send });
    googleClients({ gmail: client });

    await sendGmail(ctx, {
      bcc: [],
      body: "Подойдёт вторник в 11:00 или среда в 15:00.",
      cc: [],
      replyToMessageId: "gmail-message-1",
      to: ["admissions@ranepa.ru"],
    });

    expect(get).toHaveBeenCalledExactlyOnceWith(
      {
        format: "metadata",
        id: "gmail-message-1",
        metadataHeaders: ["Message-ID", "References", "In-Reply-To", "Subject"],
        userId: "me",
      },
      { signal: ctx.abortSignal }
    );
    const request = send.mock.calls[0]?.[0];
    expect(request?.requestBody.threadId).toBe("thread-ranepa");
    const headers = rawHeaders(request?.requestBody.raw);
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
    settings.access.mockResolvedValue("full");
    const ctx = toolContext();
    const client = GmailApi.gmail({ version: "v1" });
    const get = answeredMessageMock();
    const create = vi
      .fn<
        (
          request: {
            requestBody: { message: { raw: string; threadId?: string } };
            userId: string;
          },
          options: RequestOptions
        ) => Promise<{
          data: { id: string; message: { id: string; threadId: string } };
        }>
      >()
      .mockResolvedValue({
        data: {
          id: "draft-1",
          message: { id: "draft-message-1", threadId: "thread-ranepa" },
        },
      });
    Object.defineProperty(client.users.messages, "get", { value: get });
    Object.defineProperty(client.users.drafts, "create", { value: create });
    googleClients({ gmail: client });

    await expect(
      draftGmail(ctx, {
        bcc: [],
        body: "Черновик ответа",
        cc: [],
        replyToMessageId: "gmail-message-1",
        to: ["admissions@ranepa.ru"],
      })
    ).resolves.toMatchObject({ id: "draft-1" });

    const request = create.mock.calls[0]?.[0];
    expect(request?.userId).toBe("me");
    expect(request?.requestBody.message.threadId).toBe("thread-ranepa");
    expect(rawHeaders(request?.requestBody.message.raw)).toContain(
      "In-Reply-To: <question@ranepa.ru>"
    );
    expect(create.mock.calls[0]?.[1]).toEqual({ signal: ctx.abortSignal });
  });

  it("recovers a duplicate Calendar insert using the stable event ID", async () => {
    settings.access.mockResolvedValue("full");
    const ctx = toolContext();
    const client = CalendarApi.calendar({ version: "v3" });
    const insert = vi
      .fn<
        (
          request: {
            calendarId: string;
            requestBody: { id?: string };
            sendUpdates?: string;
          },
          options: RequestOptions
        ) => Promise<never>
      >()
      .mockRejectedValue(new GoogleApiError(409));
    const get = vi
      .fn<
        (
          request: { calendarId: string; eventId: string },
          options: RequestOptions
        ) => Promise<{ data: { id: string; summary: string } }>
      >()
      .mockResolvedValue({
        data: { id: "existing-event", summary: "Planning" },
      });
    Object.defineProperty(client.events, "get", { value: get });
    Object.defineProperty(client.events, "insert", { value: insert });
    googleClients({ calendar: client });

    await expect(
      createCalendarEvent(ctx, {
        attendees: ["person@example.com"],
        calendarId: "primary",
        end: "2026-08-28T11:00:00-04:00",
        start: "2026-08-28T10:00:00-04:00",
        summary: "Planning",
        timezone: "America/New_York",
      })
    ).resolves.toEqual({ id: "existing-event", summary: "Planning" });

    const eventId = createHash("sha256")
      .update("session-1:call-1")
      .digest("hex")
      .slice(0, 32);
    expect(insert.mock.calls[0]?.[1]).toEqual({ signal: ctx.abortSignal });
    expect(get).toHaveBeenCalledWith(
      { calendarId: "primary", eventId },
      { signal: ctx.abortSignal }
    );
  });

  it("moves a Calendar event in place and tells its attendees", async () => {
    settings.access.mockResolvedValue("full");
    const ctx = toolContext();
    const client = CalendarApi.calendar({ version: "v3" });
    const patch = vi
      .fn<
        (
          request: {
            calendarId: string;
            eventId: string;
            requestBody: CalendarApi.calendar_v3.Schema$Event;
            sendUpdates?: string;
          },
          options: RequestOptions
        ) => Promise<{ data: { id: string } }>
      >()
      .mockResolvedValue({ data: { id: "event-1" } });
    Object.defineProperty(client.events, "patch", { value: patch });
    googleClients({ calendar: client });

    await expect(
      updateCalendarEvent(ctx, {
        calendarId: "primary",
        end: "2026-09-25T11:00:00+03:00",
        eventId: "event-1",
        start: "2026-09-25T10:00:00+03:00",
        timezone: "Europe/Moscow",
      })
    ).resolves.toEqual({ id: "event-1" });

    expect(patch).toHaveBeenCalledExactlyOnceWith(
      {
        calendarId: "primary",
        eventId: "event-1",
        requestBody: {
          description: undefined,
          end: {
            dateTime: "2026-09-25T11:00:00+03:00",
            timeZone: "Europe/Moscow",
          },
          location: undefined,
          start: {
            dateTime: "2026-09-25T10:00:00+03:00",
            timeZone: "Europe/Moscow",
          },
          summary: undefined,
        },
        sendUpdates: "all",
      },
      { signal: ctx.abortSignal }
    );
  });

  it("deletes a Calendar event and treats one already gone as deleted", async () => {
    settings.access.mockResolvedValue("full");
    const ctx = toolContext();
    const client = CalendarApi.calendar({ version: "v3" });
    const remove = vi
      .fn<
        (
          request: {
            calendarId: string;
            eventId: string;
            sendUpdates?: string;
          },
          options: RequestOptions
        ) => Promise<{ data: undefined }>
      >()
      .mockResolvedValueOnce({ data: undefined })
      .mockRejectedValueOnce(new GoogleApiError(410))
      .mockRejectedValueOnce(new GoogleApiError(403));
    Object.defineProperty(client.events, "delete", { value: remove });
    googleClients({ calendar: client });
    const input = { calendarId: "primary", eventId: "event-1" };

    await expect(deleteCalendarEvent(ctx, input)).resolves.toEqual({
      alreadyDeleted: false,
    });
    await expect(deleteCalendarEvent(ctx, input)).resolves.toEqual({
      alreadyDeleted: true,
    });
    await expect(deleteCalendarEvent(ctx, input)).rejects.toBeInstanceOf(
      GoogleApiError
    );
    expect(remove).toHaveBeenCalledWith(
      { ...input, sendUpdates: "all" },
      { signal: ctx.abortSignal }
    );
  });

  it("warms the People search cache before the typed contact query", async () => {
    settings.access.mockResolvedValue("read_only");
    const ctx = toolContext();
    const client = PeopleApi.people({ version: "v1" });
    const searchContacts = vi
      .fn<
        (
          request: { pageSize?: number; query: string; readMask: string },
          options: RequestOptions
        ) => Promise<{
          data: { results?: { person: { resourceName: string } }[] };
        }>
      >()
      .mockResolvedValueOnce({ data: {} })
      .mockResolvedValueOnce({
        data: { results: [{ person: { resourceName: "people/1" } }] },
      });
    Object.defineProperty(client.people, "searchContacts", {
      value: searchContacts,
    });
    googleClients({ people: client });

    await expect(searchGoogleContacts(ctx, "Person", 10)).resolves.toEqual({
      contacts: [{ person: { resourceName: "people/1" } }],
    });

    expect(searchContacts).toHaveBeenNthCalledWith(
      1,
      {
        query: "",
        readMask: "names,emailAddresses,phoneNumbers,organizations",
      },
      { signal: ctx.abortSignal }
    );
    expect(searchContacts).toHaveBeenNthCalledWith(
      2,
      {
        pageSize: 10,
        query: "Person",
        readMask: "names,emailAddresses,phoneNumbers,organizations",
      },
      { signal: ctx.abortSignal }
    );
  });
});

function toolContext() {
  const getToken = vi
    .fn<ToolContext["getToken"]>()
    .mockResolvedValue({ token: "google-access-token" });
  const requireAuth = vi.fn<ToolContext["requireAuth"]>();
  return {
    async getSandbox() {
      throw new Error("Sandbox access is outside this focused test.");
    },
    getSkill() {
      throw new Error("Skill access is outside this focused test.");
    },
    abortSignal: new AbortController().signal,
    callId: "call-1",
    getToken,
    requireAuth,
    session: {
      auth: {
        current: {
          attributes: { workspaceId: scope.workspaceId },
          authenticator: "google-workspace-test",
          principalId: scope.userId,
          principalType: "user",
        },
        initiator: null,
      },
      id: "session-1",
      turn: { id: "turn-1", sequence: 0 },
    },
    toolName: "google-workspace-test",
  } satisfies ToolContext;
}

function stableMessageId() {
  const stableId = createHash("sha256")
    .update("session-1:call-1")
    .digest("hex")
    .slice(0, 48);
  return `<openinstinct-${stableId}@local>`;
}

function gmailSendMock() {
  return vi
    .fn<
      (
        request: {
          requestBody: { raw: string; threadId?: string };
          userId: string;
        },
        options: RequestOptions
      ) => Promise<{ data: { id: string; threadId: string } }>
    >()
    .mockResolvedValue({ data: { id: "sent-1", threadId: "thread-1" } });
}

/** The RANEPA message a reply answers, as Gmail's metadata read returns it. */
function answeredMessageMock() {
  return vi
    .fn<
      (
        request: {
          format: string;
          id: string;
          metadataHeaders: string[];
          userId: string;
        },
        options: RequestOptions
      ) => Promise<{
        data: {
          id: string;
          payload: { headers: { name: string; value: string }[] };
          threadId: string;
        };
      }>
    >()
    .mockResolvedValue({
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
    });
}

function rawHeaders(raw: string | undefined) {
  const message = Buffer.from(raw ?? "", "base64url").toString("utf8");
  return message.slice(0, message.indexOf("\r\n\r\n"));
}

function googleClients(clients: {
  calendar?: ReturnType<typeof CalendarApi.calendar>;
  gmail?: ReturnType<typeof GmailApi.gmail>;
  people?: ReturnType<typeof PeopleApi.people>;
}) {
  if (clients.calendar) calendarMock.mockReturnValue(clients.calendar);
  if (clients.gmail) gmailMock.mockReturnValue(clients.gmail);
  if (clients.people) peopleMock.mockReturnValue(clients.people);
}

class GoogleApiError extends Error {
  readonly response: { status: number };

  constructor(status: number) {
    super(`Google API returned ${String(status)}`);
    this.response = { status };
  }
}

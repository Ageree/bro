import { beforeEach, describe, expect, it, vi } from "vitest";
import type { getGoogleWorkspaceAccess } from "@db/services/settings";
import { accessScopeForUser } from "@shared/identity/access-scope";
import { type FakeComposio, fakeComposio } from "@tests/helpers/composio";

const settings = vi.hoisted(() => ({
  access: vi.fn<typeof getGoogleWorkspaceAccess>(),
}));

vi.mock("@db/services/settings", () => ({
  getGoogleWorkspaceAccess: settings.access,
}));

import { probeGoogleSignals, rankMail } from "@agent/lib/proactive/probe";

const scope = accessScopeForUser("better-auth:user-1");
const now = new Date("2026-09-24T09:00:00.000Z");
const window = {
  mailAfter: new Date("2026-09-24T08:00:00.000Z"),
  now,
  timeZone: "Europe/Moscow",
};

let composio: FakeComposio;

beforeEach(() => {
  vi.clearAllMocks();
  settings.access.mockResolvedValue("full");
  composio = fakeComposio();
  composio.proxy.mockImplementation(({ url }) =>
    url.hostname === "gmail.googleapis.com"
      ? { data: { messages: [{ id: "m1", threadId: "t1" }] } }
      : {
          data: {
            items: [
              {
                id: "flight",
                start: { dateTime: "2026-09-25T06:00:00.000Z" },
                status: "confirmed",
              },
            ],
          },
        }
  );
});

describe("probeGoogleSignals", () => {
  it("reports a person without a Google account as disconnected", async () => {
    await expect(probeGoogleSignals(scope, window)).resolves.toEqual({
      state: "disconnected",
    });
    expect(composio.proxy).not.toHaveBeenCalled();
  });

  it("lists new mail and upcoming events through the person's account", async () => {
    composio.connect({ id: "ca_google", toolkit: "googlesuper" });

    await expect(probeGoogleSignals(scope, window)).resolves.toEqual({
      signals: [
        {
          dedupeKey: "flight@2026-09-25T06:00:00.000Z",
          itemId: "flight",
          source: "calendar",
          threadId: null,
        },
        { dedupeKey: "m1", itemId: "m1", source: "gmail", threadId: "t1" },
      ],
      state: "connected",
    });
    const requests = composio.proxy.mock.calls.map(([request]) => request);
    expect(
      requests.every(
        ({ connectedAccountId }) => connectedAccountId === "ca_google"
      )
    ).toBe(true);
    expect(
      requests
        .find(({ url }) => url.hostname === "gmail.googleapis.com")
        ?.url.searchParams.get("q")
    ).toContain("in:inbox after:");
  });

  it("keeps only what may not wait for the morning at night", async () => {
    composio.connect({ id: "ca_google", toolkit: "googlesuper" });
    const subjects = new Map([
      ["m1", "го в субботу на шашлыки?"],
      ["m2", "Изменение выхода на посадку: рейс SU 1234"],
    ]);
    composio.proxy.mockImplementation(({ url }) => {
      if (url.hostname !== "gmail.googleapis.com") {
        return {
          data: {
            items: [
              {
                id: "flight",
                location: "Шереметьево",
                start: { dateTime: "2026-09-24T14:00:00.000Z" },
                status: "confirmed",
                summary: "Рейс SU 1234",
              },
              {
                id: "standup",
                start: { dateTime: "2026-09-24T12:00:00.000Z" },
                status: "confirmed",
                summary: "Планёрка",
              },
            ],
          },
        };
      }
      const id = url.pathname.split("/").at(-1) ?? "";
      return subjects.has(id)
        ? {
            data: {
              id,
              payload: {
                headers: [{ name: "Subject", value: subjects.get(id) }],
              },
              threadId: `t-${id}`,
            },
          }
        : {
            data: {
              messages: [
                { id: "m1", threadId: "t-m1" },
                { id: "m2", threadId: "t-m2" },
              ],
            },
          };
    });

    await expect(
      probeGoogleSignals(scope, { ...window, nightOnly: true })
    ).resolves.toEqual({
      signals: [
        {
          dedupeKey: "flight@2026-09-24T14:00:00.000Z",
          itemId: "flight",
          source: "calendar",
          threadId: null,
        },
        { dedupeKey: "m2", itemId: "m2", source: "gmail", threadId: "t-m2" },
      ],
      state: "connected",
    });
    const subjectRead = composio.proxy.mock.calls
      .map(([request]) => request.url)
      .find((url) => url.pathname.endsWith("/messages/m2"));
    expect(subjectRead?.searchParams.get("format")).toBe("metadata");
    expect(subjectRead?.searchParams.getAll("metadataHeaders")).toEqual([
      "Subject",
    ]);
  });

  it("looks under the read-only level's account for a read-only workspace", async () => {
    settings.access.mockResolvedValue("read_only");
    composio.connect({ id: "ca_full", toolkit: "googlesuper" });

    await expect(probeGoogleSignals(scope, window)).resolves.toEqual({
      state: "disconnected",
    });
  });

  it("reads an empty inbox and calendar the proxy hands over as an empty string", async () => {
    composio.connect({ id: "ca_google", toolkit: "googlesuper" });
    // What Composio answered on 26.09 for a Gmail list with `fields` and no
    // match: status 204 and `data: ""`.
    composio.proxy.mockResolvedValue({ data: "", status: 204 });

    await expect(probeGoogleSignals(scope, window)).resolves.toEqual({
      signals: [],
      state: "connected",
    });
  });

  it("parses a JSON answer the proxy passes on as text", async () => {
    composio.connect({ id: "ca_google", toolkit: "googlesuper" });
    composio.proxy.mockImplementation(({ url }) =>
      url.hostname === "gmail.googleapis.com"
        ? { data: JSON.stringify({ messages: [{ id: "m1", threadId: "t1" }] }) }
        : { data: "{}" }
    );

    await expect(probeGoogleSignals(scope, window)).resolves.toEqual({
      signals: [
        { dedupeKey: "m1", itemId: "m1", source: "gmail", threadId: "t1" },
      ],
      state: "connected",
    });
  });

  it("asks once more when an answer is text that is not JSON, and logs its start", async () => {
    composio.connect({ id: "ca_google", toolkit: "googlesuper" });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    let gmailCalls = 0;
    composio.proxy.mockImplementation(({ url }) => {
      if (url.hostname !== "gmail.googleapis.com") return { data: "" };
      gmailCalls += 1;
      return gmailCalls === 1
        ? { data: "upstream connect error or disconnect/reset before headers" }
        : { data: { messages: [{ id: "m1", threadId: "t1" }] } };
    });

    await expect(probeGoogleSignals(scope, window)).resolves.toMatchObject({
      signals: [{ itemId: "m1" }],
      state: "connected",
    });
    expect(warn).toHaveBeenCalledWith(
      "[proactive] unreadable Google answer, asking again",
      {
        bodyStart: "upstream connect error or disconnect/reset before headers",
        host: "gmail.googleapis.com",
      }
    );

    composio.proxy.mockResolvedValue({ data: "<html>502 Bad Gateway</html>" });
    await expect(probeGoogleSignals(scope, window)).rejects.toThrow(
      'Google answered 200 with a body that is not JSON: "<html>502 Bad Gateway</html>"'
    );
  });

  it("brings the flight reminders due now along with the new items", async () => {
    composio.connect({ id: "ca_google", toolkit: "googlesuper" });
    composio.proxy.mockImplementation(({ url }) =>
      url.hostname === "gmail.googleapis.com"
        ? { data: "", status: 204 }
        : {
            data: {
              items: [
                {
                  id: "dp405",
                  location: "Аэропорт Внуково (VKO), терминал A",
                  start: { dateTime: "2026-09-25T07:05:00+03:00" },
                  status: "confirmed",
                  summary: "Рейс DP 405 Москва (Внуково) — Сочи",
                },
              ],
            },
          }
    );
    // 19:00 in Moscow the evening before.
    const evening = new Date("2026-09-24T16:00:00.000Z");

    const probed = await probeGoogleSignals(scope, { ...window, now: evening });
    expect(
      probed.state === "connected" &&
        probed.signals.map(({ dedupeKey }) => dedupeKey)
    ).toEqual([
      "dp405@2026-09-25T07:05:00+03:00",
      "dp405@2026-09-25T07:05:00+03:00#checkin",
      "dp405@2026-09-25T07:05:00+03:00#evening",
    ]);
    const probedAtNight = await probeGoogleSignals(scope, {
      ...window,
      nightOnly: true,
      // 22:27: quiet hours began, tonight's reminder still goes.
      now: new Date("2026-09-24T19:27:00.000Z"),
    });
    expect(
      probedAtNight.state === "connected" &&
        probedAtNight.signals.map(({ dedupeKey }) => dedupeKey)
    ).toEqual([
      "dp405@2026-09-25T07:05:00+03:00",
      "dp405@2026-09-25T07:05:00+03:00#evening",
    ]);
  });

  it("treats a grant Google rejects as a disconnect", async () => {
    composio.connect({ id: "ca_google", toolkit: "googlesuper" });
    composio.proxy.mockResolvedValue({ data: {}, status: 401 });

    await expect(probeGoogleSignals(scope, window)).resolves.toEqual({
      state: "disconnected",
    });
  });
});

describe("rankMail", () => {
  const backlog = new Map([
    [
      "boss",
      {
        headers: [
          { name: "From", value: "Ирина Петрова <irina@work.example.com>" },
        ],
        labelIds: ["INBOX", "IMPORTANT"],
      },
    ],
    [
      "news",
      {
        headers: [
          { name: "From", value: "Дайджест <digest@news.example.com>" },
          { name: "List-Unsubscribe", value: "<mailto:off@news.example.com>" },
        ],
        labelIds: ["INBOX", "CATEGORY_PROMOTIONS"],
      },
    ],
    [
      "parcel",
      {
        headers: [
          { name: "From", value: "СДЭК <noreply@cdek.example.com>" },
          { name: "Subject", value: "Заказ 1234: изменился срок доставки" },
        ],
        labelIds: ["INBOX", "CATEGORY_UPDATES"],
      },
    ],
  ]);

  it("ranks a backlog by headers and labels, skipping mail that is gone", async () => {
    composio.connect({ id: "ca_google", toolkit: "googlesuper" });
    composio.proxy.mockImplementation(({ url }) => {
      const id = url.pathname.split("/").at(-1) ?? "";
      const described = backlog.get(id);
      return described
        ? {
            data: {
              id,
              labelIds: described.labelIds,
              payload: { headers: described.headers },
              threadId: `t-${id}`,
            },
          }
        : { data: {}, status: 404 };
    });

    const ranks = await rankMail(scope, [
      { itemId: "news" },
      { itemId: "parcel" },
      { itemId: "gone" },
      { itemId: "boss" },
    ]);

    expect(Object.fromEntries(ranks)).toEqual({ boss: 1, news: 3, parcel: 0 });
    const read = composio.proxy.mock.calls
      .map(([request]) => request.url)
      .find((url) => url.pathname.endsWith("/messages/news"));
    expect(read?.searchParams.get("fields")).toBe(
      "id,threadId,labelIds,payload/headers"
    );
    expect(read?.searchParams.getAll("metadataHeaders")).toEqual([
      "From",
      "List-Id",
      "List-Unsubscribe",
      "Precedence",
      "Subject",
    ]);
  });

  it("keeps the newest-first order when the backlog cannot be read", async () => {
    composio.connect({ id: "ca_google", toolkit: "googlesuper" });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    composio.proxy.mockRejectedValue(new Error("socket hang up"));

    await expect(rankMail(scope, [{ itemId: "news" }])).resolves.toEqual(
      new Map()
    );
    expect(warn).toHaveBeenCalledWith(
      "[proactive] could not rank the backlog",
      expect.anything()
    );
  });
});

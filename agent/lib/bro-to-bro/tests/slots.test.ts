import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { getGoogleWorkspaceAccess } from "@db/services/settings";
import { accessScopeForUser } from "@shared/identity/access-scope";
import { type FakeComposio, fakeComposio } from "@tests/helpers/composio";

const settings = vi.hoisted(() => ({
  access: vi.fn<typeof getGoogleWorkspaceAccess>(),
}));

vi.mock("@db/services/settings", () => ({
  getGoogleWorkspaceAccess: settings.access,
}));

import {
  readSlotCandidates,
  slotCandidates,
} from "@agent/lib/bro-to-bro/slots";

const hour = 60 * 60_000;

function span(start: string, end: string) {
  return { end: Date.parse(end), start: Date.parse(start) };
}

describe("slotCandidates", () => {
  it("keeps free windows of the owner's day long enough for the meeting, on the half hour", () => {
    expect(
      slotCandidates({
        busy: [
          span("2026-10-24T09:00:00+03:00", "2026-10-24T13:10:00+03:00"),
          // Thirty free minutes before it: too short for an hour.
          span("2026-10-24T14:00:00+03:00", "2026-10-24T17:00:00+03:00"),
          span("2026-10-25T11:00:00+03:00", "2026-10-25T20:15:00+03:00"),
        ],
        durationMinutes: 60,
        range: span("2026-10-24T00:00:00+03:00", "2026-10-26T00:00:00+03:00"),
        timeZone: "Europe/Moscow",
      })
    ).toEqual([
      { end: "2026-10-24T23:00:00+03:00", start: "2026-10-24T17:00:00+03:00" },
      { end: "2026-10-25T11:00:00+03:00", start: "2026-10-25T09:00:00+03:00" },
      { end: "2026-10-25T23:00:00+03:00", start: "2026-10-25T20:30:00+03:00" },
    ]);
  });

  it("reads the day in the owner's own zone", () => {
    expect(
      slotCandidates({
        busy: [],
        durationMinutes: 120,
        range: span("2026-10-24T05:07:00Z", "2026-10-24T17:50:00Z"),
        timeZone: "Asia/Yekaterinburg",
      })
    ).toEqual([
      { end: "2026-10-24T22:30:00+05:00", start: "2026-10-24T10:30:00+05:00" },
    ]);
  });

  it("gives at most eight, one a day before a day's second", () => {
    const start = Date.parse("2026-10-24T00:00:00+03:00");
    const lunches = Array.from({ length: 10 }, (_, day) => ({
      end: start + day * 24 * hour + 14 * hour,
      start: start + day * 24 * hour + 13 * hour,
    }));

    const candidates = slotCandidates({
      busy: lunches,
      durationMinutes: 60,
      range: { end: start + 10 * 24 * hour, start },
      timeZone: "Europe/Moscow",
    });

    expect(candidates).toHaveLength(8);
    expect(
      new Set(candidates.map(({ start: at }) => at.slice(0, 10))).size
    ).toBe(8);
    // Each day's longer window, after lunch.
    expect(
      candidates.every(({ start: at }) => at.endsWith("T14:00:00+03:00"))
    ).toBe(true);
  });

  it("keeps the window that holds the peer's proposal, however far off its day", () => {
    const start = Date.parse("2026-10-24T00:00:00+03:00");
    const proposed = span(
      "2026-11-20T19:00:00+03:00",
      "2026-11-20T21:00:00+03:00"
    );

    const candidates = slotCandidates({
      around: proposed,
      busy: [],
      durationMinutes: 120,
      range: { end: start + 40 * 24 * hour, start },
      timeZone: "Europe/Moscow",
    });

    expect(candidates).toHaveLength(8);
    expect(candidates).toContainEqual({
      end: "2026-11-20T23:00:00+03:00",
      start: "2026-11-20T09:00:00+03:00",
    });
  });
});

describe("readSlotCandidates", () => {
  const scope = accessScopeForUser("better-auth:user-1");
  let composio: FakeComposio;

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-10-23T12:00:00+03:00"));
    settings.access.mockResolvedValue("full");
    composio = fakeComposio();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("asks Google only for busy time, from now on", async () => {
    composio.connect({ id: "ca_google", toolkit: "googlesuper" });
    composio.proxy.mockImplementation(() => ({
      data: {
        calendars: {
          primary: {
            busy: [
              {
                end: "2026-10-24T17:00:00Z",
                start: "2026-10-24T06:00:00Z",
              },
            ],
          },
        },
      },
    }));

    const slots = await readSlotCandidates(scope, {
      timeZone: "Europe/Moscow",
      window: {
        from: "2026-10-20T00:00:00+03:00",
        to: "2026-10-24T23:00:00+03:00",
      },
    });

    expect(slots).toEqual({
      candidates: [
        {
          end: "2026-10-23T23:00:00+03:00",
          start: "2026-10-23T12:00:00+03:00",
        },
        {
          end: "2026-10-24T23:00:00+03:00",
          start: "2026-10-24T20:00:00+03:00",
        },
      ],
      state: "known",
    });
    const [request] = composio.proxy.mock.calls.map(([each]) => each);
    expect(composio.proxy).toHaveBeenCalledOnce();
    expect(request?.url.pathname).toBe("/calendar/v3/freeBusy");
    expect(request?.body).toMatchObject({
      items: [{ id: "primary" }],
      timeMin: "2026-10-23T09:00:00.000Z",
    });
  });

  it("is unavailable without a connected Google", async () => {
    await expect(
      readSlotCandidates(scope, {
        timeZone: "Europe/Moscow",
        window: {
          from: "2026-10-24T00:00:00+03:00",
          to: "2026-10-26T00:00:00+03:00",
        },
      })
    ).resolves.toEqual({ state: "unavailable" });
    expect(composio.proxy).not.toHaveBeenCalled();
  });
});

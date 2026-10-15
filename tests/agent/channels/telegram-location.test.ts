import type { RouteHandlerArgs } from "eve/channels";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import type * as EnvModule from "@shared/environment";
import type { findChannelIdentity } from "@db/services/channel-identities";
import type * as LocationService from "@db/services/location";
import { accessScopeForUser } from "@shared/identity/access-scope";

/**
 * The live location route: a wrong or missing secret is refused (fail
 * closed), anything but the person's own private chat in the pilot is
 * dropped with 200, an old edit does nothing, and the reminders run at most
 * every 15 s while the track is stored every minute or 50 m.
 */

const secret = "telegram-test-webhook-secret";

const capture = vi.hoisted(() => ({
  // SAFETY: The mock factory fills this object with the real environment before any test runs.
  env: {} as Record<string, string | undefined>,
  evaluate: vi.fn<typeof LocationService.evaluatePlaceReminders>(),
  findIdentity: vi.fn<typeof findChannelIdentity>(),
  insert: vi.fn<typeof LocationService.insertPoint>(),
  pilot: vi.fn<typeof LocationService.locationPilot>(),
  recent: vi.fn<typeof LocationService.recentLiveWrite>(),
}));

vi.mock("@shared/environment", async (importOriginal) => {
  const original = await importOriginal<typeof EnvModule>();
  Object.assign(capture.env, original.env, {
    TELEGRAM_WEBHOOK_SECRET_TOKEN: secret,
  });
  return { ...original, env: capture.env };
});
vi.mock("@db/services/channel-identities", () => ({
  findChannelIdentity: capture.findIdentity,
}));
vi.mock("@db/services/location", () => ({
  evaluatePlaceReminders: capture.evaluate,
  insertPoint: capture.insert,
  locationPilot: capture.pilot,
  recentLiveWrite: capture.recent,
}));

const editedAt = 1_760_522_400;
const chatId = 4242;

function edit(
  overrides: Partial<{
    chat: { id: number; type: string };
    editDate: number;
    forwarded: boolean;
    fromId: number;
    isBot: boolean;
    lat: number;
    livePeriod: number | undefined;
    viaBot: boolean;
  }> = {}
) {
  const livePeriod = "livePeriod" in overrides ? overrides.livePeriod : 3_600;
  return {
    edited_message: {
      chat: overrides.chat ?? { id: chatId, type: "private" },
      date: editedAt - 600,
      edit_date: overrides.editDate ?? editedAt,
      from: {
        id: overrides.fromId ?? chatId,
        is_bot: overrides.isBot ?? false,
      },
      location: {
        horizontal_accuracy: 12,
        latitude: overrides.lat ?? 55.75,
        longitude: 37.61,
        ...(livePeriod !== undefined && { live_period: livePeriod }),
      },
      message_id: 77,
      ...(overrides.forwarded === true && {
        forward_date: editedAt - 900,
        forward_origin: { date: editedAt - 900, type: "user" },
      }),
      ...(overrides.viaBot === true && {
        via_bot: { first_name: "Map", id: 555, is_bot: true },
      }),
    },
    update_id: 1,
  };
}

/** What the route answers: flags and a count. */
const answerSchema = z.record(z.string(), z.union([z.boolean(), z.number()]));

/** What the bridge may post: an edit, or any other update. */
type Update =
  | ReturnType<typeof edit>
  | { readonly message: { readonly text: string }; readonly update_id: number };

async function post(body: Update, headers: Record<string, string> = {}) {
  const { default: channel } =
    await import("@agent/channels/telegram-location");
  const [route] = channel.routes;
  if (!route) throw new Error("Expected the POST route.");
  const response = await route.handler(
    new Request("http://127.0.0.1:4274/eve/v1/telegram-location", {
      body: JSON.stringify(body),
      headers: { "content-type": "application/json", ...headers },
      method: "POST",
    }),
    routeContext()
  );
  if (!(response instanceof Response)) throw new Error("Expected a response.");
  return {
    body: answerSchema.parse(await response.json()),
    status: response.status,
  };
}

const alice = accessScopeForUser("better-auth:alice");

const withSecret = { "x-telegram-bot-api-secret-token": secret };

beforeEach(() => {
  capture.env.TELEGRAM_WEBHOOK_SECRET_TOKEN = secret;
  capture.findIdentity.mockResolvedValue({
    channel: "telegram",
    chatId: String(chatId),
    externalUserId: String(chatId),
    linkedAt: new Date(),
    userId: "alice",
    username: null,
    workspaceId: "personal:alice",
  });
  capture.pilot.mockReturnValue(true);
  // The share's first message, stored as the person's own point.
  capture.recent.mockResolvedValue({
    lat: 55.75,
    lon: 37.61,
    recordedAt: new Date((editedAt - 600) * 1000),
  });
  capture.evaluate.mockResolvedValue([]);
  capture.insert.mockImplementation(async () => ({
    accuracyM: 12,
    address: null,
    createdAt: new Date(),
    externalId: "x",
    id: "point-1",
    kind: "position",
    label: null,
    lat: 55.75,
    liveKey: `${String(chatId)}:77`,
    lon: 37.61,
    recordedAt: new Date(),
    source: "telegram_live",
    workspaceId: "personal:alice",
  }));
});

afterEach(() => {
  vi.resetModules();
  for (const mock of [
    capture.evaluate,
    capture.findIdentity,
    capture.insert,
    capture.pilot,
    capture.recent,
  ]) {
    mock.mockReset();
  }
});

describe("the live location route", () => {
  it("refuses a missing or wrong secret, and any secret when none is set", async () => {
    expect((await post(edit())).status).toBe(401);
    expect(
      (await post(edit(), { "x-telegram-bot-api-secret-token": "nope" })).status
    ).toBe(401);
    capture.env.TELEGRAM_WEBHOOK_SECRET_TOKEN = undefined;
    expect((await post(edit(), withSecret)).status).toBe(401);
    expect(capture.findIdentity).not.toHaveBeenCalled();
  });

  it("drops what is not the person's own private chat in the pilot", async () => {
    for (const body of [
      { update_id: 2, message: { text: "привет" } },
      edit({ chat: { id: -100_123, type: "supergroup" } }),
      edit({ fromId: 9 }),
      edit({ isBot: true }),
    ]) {
      // oxlint-disable-next-line eslint/no-await-in-loop -- Each update is its own request.
      expect(await post(body, withSecret)).toEqual({
        body: { ignored: true },
        status: 200,
      });
    }
    capture.findIdentity.mockResolvedValue(undefined);
    expect((await post(edit(), withSecret)).body).toEqual({ ignored: true });
    capture.findIdentity.mockClear();
    capture.pilot.mockReturnValue(false);
    expect((await post(edit(), withSecret)).body).toEqual({ ignored: true });
    expect(capture.evaluate).not.toHaveBeenCalled();
    expect(capture.insert).not.toHaveBeenCalled();
  });

  it("drops a forwarded share, one sent through a bot, and one never stored as the person's own", async () => {
    expect((await post(edit({ forwarded: true }), withSecret)).body).toEqual({
      ignored: true,
    });
    expect((await post(edit({ viaBot: true }), withSecret)).body).toEqual({
      ignored: true,
    });
    capture.recent.mockResolvedValue(undefined);
    expect((await post(edit(), withSecret)).body).toEqual({ ignored: true });
    expect(capture.evaluate).not.toHaveBeenCalled();
    expect(capture.insert).not.toHaveBeenCalled();
  });

  it("runs the reminders as a live edit and stores it", async () => {
    const { body } = await post(edit(), withSecret);
    expect(body).toEqual({ evaluated: true, hits: 0, stored: true });
    expect(capture.evaluate).toHaveBeenCalledWith(
      alice,
      expect.objectContaining({
        accuracyM: 12,
        leaveAllowed: true,
        live: true,
        recordedAt: new Date(editedAt * 1000),
      }),
      expect.objectContaining({ via: "live" })
    );
    expect(capture.insert).toHaveBeenCalledWith(
      alice,
      expect.objectContaining({
        externalId: `telegram:${String(chatId)}:77:${String(editedAt)}`,
        liveKey: `${String(chatId)}:77`,
        source: "telegram_live",
      })
    );
  });

  it("skips old edits, and stores and runs at their own pace", async () => {
    capture.recent.mockResolvedValue({
      lat: 55.75,
      lon: 37.61,
      recordedAt: new Date(editedAt * 1000),
    });
    // Not newer than the stored point: nothing to do.
    expect((await post(edit(), withSecret)).body).toEqual({ stale: true });
    // 20 s later, in place: the reminders run, the track waits.
    expect(
      (await post(edit({ editDate: editedAt + 20 }), withSecret)).body
    ).toEqual({ evaluated: true, hits: 0, stored: false });
    // 10 s after that run: too soon to run again, and still in place.
    expect(
      (await post(edit({ editDate: editedAt + 30 }), withSecret)).body
    ).toEqual({ evaluated: false, hits: 0, stored: false });
    // 100 m away: stored though the minute has not passed.
    expect(
      (await post(edit({ editDate: editedAt + 40, lat: 55.751 }), withSecret))
        .body
    ).toEqual({ evaluated: true, hits: 0, stored: true });
    // The edit that ends the share is stored and run whatever the pace.
    expect(
      (
        await post(
          edit({ editDate: editedAt + 45, livePeriod: undefined }),
          withSecret
        )
      ).body
    ).toEqual({ evaluated: true, hits: 0, stored: true });
  });
});

function routeContext() {
  return {
    attachSession: unexpected,
    from: unexpected,
    params: {},
    requestIp: null,
    resolveSession: unexpected,
    to: unexpected,
    waitUntil: unexpected,
  } satisfies RouteHandlerArgs;
}

function unexpected(): never {
  throw new Error("The live location route starts no session.");
}

import { beforeEach, describe, expect, it, vi } from "vitest";
import type * as LocationService from "@db/services/location";
import type * as ProactiveService from "@db/services/proactive";
import type * as UserProfileService from "@db/services/user-profile";
import { readHistory } from "@agent/lib/location/stays";
import { accessScopeForUser } from "@shared/identity/access-scope";

/**
 * Bro following a live share: a stop somewhere new and a departure 500 m
 * away are moves worth a look, the place the share began at and walking
 * round one place are not; a move is keyed so it is handed over once, and
 * nothing is read at night or outside the pilot.
 */

const capture = vi.hoisted(() => ({
  labelNear: vi.fn<typeof LocationService.labelNear>(),
  pilot: vi.fn<typeof LocationService.locationWatchPilot>(),
  queue: vi.fn<typeof ProactiveService.queueLocationRun>(),
  timeZone: vi.fn<typeof UserProfileService.readWorkspaceTimeZone>(),
  track: vi.fn<typeof LocationService.readShareTrack>(),
}));

vi.mock("@db/services/location", () => ({
  labelNear: capture.labelNear,
  locationWatchPilot: capture.pilot,
  readShareTrack: capture.track,
}));
vi.mock("@db/services/proactive", () => ({
  queueLocationRun: capture.queue,
}));
vi.mock("@db/services/user-profile", () => ({
  readWorkspaceTimeZone: capture.timeZone,
}));
vi.mock("@agent/lib/location/address", () => ({
  pointAddressNow: vi.fn(async () => "Тверская улица, 7, Москва"),
}));
vi.mock("@agent/lib/routes/openstreetmap", () => ({
  nearbyPlace: vi.fn(async () => ({ name: "Кофемания" })),
}));

/** Noon in Moscow: not the person's night. */
const start = new Date("2026-10-15T09:00:00.000Z").getTime();
const minute = 60_000;
/** About 111 m of latitude. */
const step = 0.001;
const home = { lat: 55.75, lon: 37.6 };
const liveKey = "4242:77";
const alice = accessScopeForUser("better-auth:alice");

let counter = 0;
function at(minutes: number, lat: number) {
  counter += 1;
  return {
    accuracyM: 10,
    address: null,
    createdAt: new Date(start + minutes * minute),
    externalId: `telegram:${String(counter)}`,
    id: `p${String(counter)}`,
    kind: "position" as const,
    label: null,
    lat,
    liveKey,
    lon: home.lon,
    recordedAt: new Date(start + minutes * minute),
    source: "telegram_live" as const,
    workspaceId: alice.workspaceId,
  };
}

/** Points every minute at one place, for `minutes` minutes from `from`. */
function stay(from: number, minutes: number, lat: number) {
  return Array.from({ length: minutes + 1 }, (_, index) =>
    at(from + index, lat + (index % 2) * 0.0002)
  );
}

/** A walk north at about 5 km/h, one point a minute, for `minutes`. */
function walk(from: number, minutes: number, lat: number) {
  const perMinute = (5 / 60) * (step / 0.111);
  return Array.from({ length: minutes }, (_, index) =>
    at(from + index + 1, lat + perMinute * (index + 1))
  );
}

/** Where a walk of `minutes` from `lat` ends. */
function walked(minutes: number, lat: number) {
  return lat + (5 / 60) * (step / 0.111) * minutes;
}

function minutesIn(minutes: number) {
  return new Date(start + minutes * minute);
}

async function watch() {
  return import("@agent/lib/location/watch");
}

beforeEach(() => {
  vi.clearAllMocks();
  capture.pilot.mockReturnValue(true);
  capture.timeZone.mockResolvedValue("Europe/Moscow");
  capture.labelNear.mockResolvedValue(undefined);
  capture.queue.mockResolvedValue({ runId: "run-1", status: "queued" });
});

describe("a move on a live share", () => {
  it("reads a stop somewhere new after a walk as an arrival", async () => {
    const { liveMove, liveMoveSignal } = await watch();
    const shop = walked(15, home.lat);
    const track = [...stay(0, 10, home.lat), ...walk(10, 15, home.lat)];
    track.push(...stay(26, 6, shop));
    const latest = track.at(-1);
    if (!latest) throw new Error("A track has points.");
    const items = readHistory(track);
    const move = liveMove(items, latest, minutesIn(33));
    expect(move?.kind).toBe("arrive");
    const arrived = items.at(-1);
    if (!move || arrived?.kind !== "stay") throw new Error("Expected a stop.");
    expect(liveMoveSignal(liveKey, move)).toEqual({
      dedupeKey: `${liveKey}#arrive@${String(arrived.start.getTime())}`,
      itemId: liveKey,
      source: "location",
      threadId: null,
    });
  });

  it("takes no arrival at the place the share began, nor one near the last stay", async () => {
    const { liveMove } = await watch();
    const atStart = stay(0, 20, home.lat);
    const first = atStart.at(-1);
    if (!first) throw new Error("A track has points.");
    expect(
      liveMove(readHistory(atStart), first, minutesIn(21))
    ).toBeUndefined();

    const roundTheBlock = [
      ...stay(0, 10, home.lat),
      ...walk(10, 4, home.lat),
      ...stay(15, 6, walked(4, home.lat)),
    ];
    const last = roundTheBlock.at(-1);
    if (!last) throw new Error("A track has points.");
    expect(
      liveMove(readHistory(roundTheBlock), last, minutesIn(22))
    ).toBeUndefined();
  });

  it("reads a departure 500 m away, keyed by the last point at the place left", async () => {
    const { liveMove, liveMoveSignal } = await watch();
    const near = [...stay(0, 30, home.lat), ...walk(30, 3, home.lat)];
    const close = near.at(-1);
    if (!close) throw new Error("A track has points.");
    expect(liveMove(readHistory(near), close, minutesIn(34))).toBeUndefined();

    const away = [...stay(0, 30, home.lat), ...walk(30, 9, home.lat)];
    const latest = away.at(-1);
    if (!latest) throw new Error("A track has points.");
    const items = readHistory(away);
    const move = liveMove(items, latest, minutesIn(40));
    expect(move?.kind).toBe("leave");
    const left = items.at(-2);
    if (!move || left?.kind !== "stay") throw new Error("Expected a stay.");
    // The stay's start slides with the window read; its end does not.
    expect(liveMoveSignal(liveKey, move).dedupeKey).toBe(
      `${liveKey}#leave@${String(left.end.getTime())}`
    );
  });

  it("says nothing of a share gone quiet or a stop long ago", async () => {
    const { liveMove } = await watch();
    const track = [
      ...stay(0, 10, home.lat),
      ...walk(10, 15, home.lat),
      ...stay(26, 6, walked(15, home.lat)),
    ];
    const latest = track.at(-1);
    if (!latest) throw new Error("A track has points.");
    expect(
      liveMove(readHistory(track), latest, minutesIn(32 + 11))
    ).toBeUndefined();
    const stayedOn = [...track, ...stay(33, 40, walked(15, home.lat))];
    const last = stayedOn.at(-1);
    if (!last) throw new Error("A track has points.");
    expect(
      liveMove(readHistory(stayedOn), last, minutesIn(74))
    ).toBeUndefined();
  });
});

describe("following a live share", () => {
  const arrival = [
    ...stay(0, 10, home.lat),
    ...walk(10, 15, home.lat),
    ...stay(26, 6, walked(15, home.lat)),
  ];

  it("queues Bro's check for a move, once a minute of the share at most", async () => {
    const { noticeLiveMove } = await watch();
    capture.track.mockResolvedValue(arrival);
    const stopped = readHistory(arrival).at(-1);
    if (stopped?.kind !== "stay") throw new Error("Expected a stop.");
    await expect(
      noticeLiveMove(alice, "share-a", minutesIn(32), minutesIn(32))
    ).resolves.toBe("arrive:queued");
    expect(capture.queue).toHaveBeenCalledWith(
      expect.objectContaining({
        perDay: 12,
        signal: expect.objectContaining({
          dedupeKey: `share-a#arrive@${String(stopped.start.getTime())}`,
          source: "location",
        }),
        workspaceId: alice.workspaceId,
      })
    );
    await expect(
      noticeLiveMove(alice, "share-a", minutesIn(32.5), minutesIn(32.5))
    ).resolves.toBe("throttled");
  });

  it("reads nothing outside the pilot or at the person's night", async () => {
    const { noticeLiveMove } = await watch();
    capture.track.mockResolvedValue(arrival);
    capture.pilot.mockReturnValue(false);
    await expect(
      noticeLiveMove(alice, "share-b", minutesIn(32), minutesIn(32))
    ).resolves.toBe("off");
    capture.pilot.mockReturnValue(true);
    const night = new Date("2026-10-15T21:00:00.000Z");
    await expect(noticeLiveMove(alice, "share-c", night, night)).resolves.toBe(
      "night"
    );
    expect(capture.track).not.toHaveBeenCalled();
    expect(capture.queue).not.toHaveBeenCalled();
  });

  it("tells the run where the person is now and how they got there", async () => {
    const { liveMoveLines } = await watch();
    capture.track.mockResolvedValue(arrival);
    capture.labelNear.mockImplementation(async (_scope, point) =>
      point.lat < home.lat + step ? "дом" : undefined
    );
    const lines = await liveMoveLines(
      alice,
      { dedupeKey: `${liveKey}#arrive@1`, itemId: liveKey },
      "Europe/Moscow",
      minutesIn(33)
    );
    expect(lines.every((line) => line.startsWith("Геопозиция:"))).toBe(true);
    const text = lines.join("\n");
    expect(text).toContain("«Тверская улица, 7, Москва»");
    expect(text).toContain("Координаты для route_time");
    expect(text).toContain("похоже, пешком");
    expect(text).toContain("«дом»");
  });
});

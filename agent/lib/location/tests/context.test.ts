import { afterEach, describe, expect, it, vi } from "vitest";
import type * as points from "@db/services/location";

const latestPosition = vi.fn<typeof points.latestPosition>();
vi.mock("@db/services/location", () => ({
  cachedAddressNear: vi.fn<typeof points.cachedAddressNear>(
    async () => undefined
  ),
  latestPosition,
  setPointAddress: vi.fn<typeof points.setPointAddress>(),
}));
vi.mock("@db/services/user-profile", () => ({
  readWorkspaceTimeZone: vi.fn<() => Promise<string>>(
    async () => "Europe/Moscow"
  ),
}));
vi.mock("@agent/lib/routes/openstreetmap", () => ({
  reverseGeocode: vi.fn<() => Promise<string | undefined>>(
    async () => undefined
  ),
}));

const scope = { userId: "user-1", workspaceId: "workspace-1" };
const row = {
  createdAt: new Date("2026-10-15T10:00:00.000Z"),
  externalId: "telegram:1:2:3",
  kind: "position" as const,
  label: null,
  liveKey: null,
  source: "telegram" as const,
  workspaceId: "workspace-1",
};
const now = new Date("2026-10-15T11:00:00.000Z");

afterEach(() => {
  latestPosition.mockReset();
});

describe("the line of where the person last was", () => {
  it("comes only for words about places near, with a point of 2 hours", async () => {
    const { locationContext, speaksOfPlaces } =
      await import("@agent/lib/location/context");
    latestPosition.mockResolvedValue({
      live: false,
      point: {
        ...row,
        accuracyM: 15,
        address: "Тверская улица 7, Москва",
        id: "p1",
        lat: 55.76,
        lon: 37.61,
        recordedAt: new Date(now.getTime() - 30 * 60_000),
      },
    });
    expect(speaksOfPlaces("что поесть рядом?")).toBe(true);
    expect(speaksOfPlaces("напиши маме")).toBe(false);
    expect(await locationContext(scope, "напиши маме", now)).toEqual([]);
    expect(latestPosition).not.toHaveBeenCalled();
    const [line] = await locationContext(scope, "где тут кофе рядом", now);
    expect(line).toContain("последняя точка, которой человек делился");
    expect(line).toContain("Тверская улица 7");
    latestPosition.mockResolvedValue({
      live: false,
      point: {
        ...row,
        accuracyM: 15,
        address: null,
        id: "p1",
        lat: 55.76,
        lon: 37.61,
        recordedAt: new Date(now.getTime() - 3 * 60 * 60_000),
      },
    });
    expect(await locationContext(scope, "что рядом", now)).toEqual([]);
  });
});

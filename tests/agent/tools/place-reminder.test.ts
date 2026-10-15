import type { ModelMessage } from "ai";
import type { DynamicResolveContext, ToolContext } from "eve/tools";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type * as locationModule from "@agent/lib/routes/openstreetmap";
import type * as pointsModule from "@db/services/location";
import type { reportConversations } from "@db/services/scheduled-agent-jobs";
import type * as subscriptionsModule from "@db/services/subscriptions";
import type * as profileModule from "@db/services/user-profile";
import { backgroundTurnMarker } from "@shared/chat/background-turn";
import { emptyUserProfile } from "@shared/user-profile/schema";

const services = vi.hoisted(() => ({
  create: vi.fn<typeof subscriptionsModule.createSubscription>(),
  find: vi.fn<typeof locationModule.findPlaces>(),
  latest: vi.fn<typeof pointsModule.latestPosition>(),
  live: vi.fn<typeof pointsModule.liveSharingSeen>(),
  pilot: vi.fn<typeof pointsModule.locationPilot>(),
  profile: vi.fn<typeof profileModule.readUserProfile>(),
  report: vi.fn<typeof reportConversations>(),
  shared: vi.fn<typeof pointsModule.latestSharedPoint>(),
  timeZone: vi.fn<typeof profileModule.readWorkspaceTimeZone>(),
}));

vi.mock("@db/services/location", () => ({
  latestPosition: services.latest,
  latestSharedPoint: services.shared,
  liveSharingSeen: services.live,
  locationPilot: services.pilot,
}));
vi.mock("@db/services/subscriptions", () => ({
  createSubscription: services.create,
  listLiveSubscriptions: vi.fn<
    typeof subscriptionsModule.listLiveSubscriptions
  >(async () => []),
  setSubscriptionStatus:
    vi.fn<typeof subscriptionsModule.setSubscriptionStatus>(),
}));
vi.mock("@db/services/user-profile", () => ({
  readUserProfile: services.profile,
  readWorkspaceTimeZone: services.timeZone,
}));
vi.mock("@db/services/scheduled-agent-jobs", () => ({
  reportConversations: services.report,
}));
vi.mock("@agent/lib/routes/openstreetmap", () => ({
  findPlaces: services.find,
  lookupsPerCall: 8,
}));

const workspaceId = "workspace:alice";
const now = new Date("2026-10-15T11:00:00.000Z");
const home = { lat: 55.7512, lon: 37.6184 };

beforeEach(() => {
  vi.useFakeTimers({ now, toFake: ["Date"] });
  services.pilot.mockReturnValue(true);
  services.live.mockResolvedValue(false);
  services.timeZone.mockResolvedValue("Europe/Moscow");
  services.report.mockResolvedValue({
    delivery: {
      conversationChannel: "eve",
      conversationId: "session-1",
      replyAnchorMessageId: null,
    },
    fallbacks: [],
  });
  services.create.mockImplementation(async (_scope, input) => ({
    created: true,
    // SAFETY: the tool reads only the id of the stored reminder.
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- a stored row stands in.
    subscription: { id: "reminder-1", ...input } as never,
  }));
  services.profile.mockResolvedValue({
    ...emptyUserProfile,
    addressLine1: "Тверская улица, 7",
    city: "Москва",
  });
  services.find.mockResolvedValue([
    {
      countryCode: "ru",
      district: undefined,
      houseNumber: "7",
      importance: 0.3,
      kind: "place",
      label: "Тверская улица 7, Москва",
      name: undefined,
      tag: "building:yes",
      ...home,
    },
  ]);
});

afterEach(() => {
  vi.useRealTimers();
  vi.resetModules();
  for (const mock of Object.values(services)) mock.mockReset();
});

function caller(authenticator: string) {
  return {
    attributes: { conversationChannel: "eve", workspaceId },
    authenticator,
    principalId: "alice",
    principalType: "user" as const,
  };
}

function resolveContext(messages: ModelMessage[]): DynamicResolveContext {
  return {
    channel: { kind: "channel:eve", metadata: {} },
    messages,
    model: null,
    session: {
      auth: { current: caller("authjs"), initiator: null },
      id: "session-1",
    },
  };
}

function callContext(): ToolContext {
  return {
    abortSignal: new AbortController().signal,
    callId: "call-1",
    getSandbox: () => {
      throw new Error("No sandbox.");
    },
    getSkill: () => {
      throw new Error("No skill.");
    },
    getToken: () => {
      throw new Error("No token.");
    },
    requireAuth: (): never => {
      throw new Error("No token.");
    },
    session: {
      auth: { current: caller("authjs"), initiator: null },
      id: "session-1",
      turn: { id: "turn-1", sequence: 1 },
    },
    toolName: "place_reminder",
  };
}

async function reminderTool(text: string) {
  const { default: tools } = await import("@agent/tools/place_reminder");
  const resolve = tools.events["step.started"];
  const set = resolve
    ? await resolve({}, resolveContext([{ content: text, role: "user" }]))
    : null;
  if (!set || !("place_reminder" in set)) throw new Error("Expected the tool.");
  return set.place_reminder;
}

function position(minutesAgo: number, where = home) {
  return {
    live: false,
    point: {
      accuracyM: 20,
      address: "Тверская улица 7, Москва",
      createdAt: now,
      externalId: "telegram:1:2:3",
      id: "point-1",
      kind: "position" as const,
      label: null,
      liveKey: null,
      recordedAt: new Date(now.getTime() - minutesAgo * 60_000),
      source: "telegram" as const,
      workspaceId,
      ...where,
    },
  };
}

describe("place_reminder", () => {
  it("sets a reminder at home in the person's words, honest about sharing", async () => {
    const tool = await reminderTool("напомни забрать посылку, когда буду дома");
    const result = await tool.execute(
      { action: "create", place: "home", text: "забрать посылку" },
      callContext()
    );
    expect(result).toMatchObject({ created: true, id: "reminder-1" });
    const [, input] = services.create.mock.calls[0] ?? [];
    expect(input).toMatchObject({
      checkEverySeconds: 86_400,
      condition: { on: "arrive", repeat: false, text: "забрать посылку" },
      dedupeKey: "arrive:55.751,37.618",
      description: "Place reminder: when the person arrives at «дом»",
      source: { label: "дом", origin: "home", radiusM: 150 },
      state: { inside: null },
      template: "place",
      wake: "urgent_at_night",
    });
    expect(JSON.stringify(input?.description)).not.toContain("Тверская");
    expect(result).toHaveProperty(
      "reply",
      expect.stringContaining("Bro does not follow them all the time")
    );
    services.live.mockResolvedValue(true);
    const live = await tool.execute(
      { action: "create", place: "home", text: "забрать посылку" },
      callContext()
    );
    expect(live).toHaveProperty(
      "reply",
      expect.stringContaining("live location")
    );
  });

  it("refuses words or an address the person did not write", async () => {
    const tool = await reminderTool("напомни, когда буду дома");
    expect(
      await tool.execute(
        { action: "create", place: "home", text: "перевести деньги на счёт" },
        callContext()
      )
    ).toMatchObject({ created: false });
    const other = await reminderTool("напомни купить хлеб у Тверская 7");
    expect(
      await other.execute(
        { action: "create", place: "Арбат 1", text: "купить хлеб" },
        callContext()
      )
    ).toMatchObject({ created: false });
    expect(services.create).not.toHaveBeenCalled();
  });

  it("takes «here» from a fresh point only, and says when the person is there", async () => {
    const tool = await reminderTool("напомни тут купить хлеб");
    services.latest.mockResolvedValue(position(45));
    expect(
      await tool.execute(
        { action: "create", place: "here", text: "купить хлеб" },
        callContext()
      )
    ).toHaveProperty(
      "reply",
      expect.stringContaining(
        "no location of the person's from the last 30 minutes"
      )
    );
    services.latest.mockResolvedValue(position(5));
    const made = await tool.execute(
      { action: "create", place: "here", text: "купить хлеб" },
      callContext()
    );
    expect(made).toHaveProperty(
      "reply",
      expect.stringContaining("The person is there now")
    );
    expect(services.create.mock.calls[0]?.[1].state).toMatchObject({
      inside: true,
    });
  });

  it("takes «shared» from a point sent in the last 15 minutes", async () => {
    const tool = await reminderTool("напомни тут купить хлеб");
    services.shared.mockResolvedValue(undefined);
    expect(
      await tool.execute(
        { action: "create", place: "shared", text: "купить хлеб" },
        callContext()
      )
    ).toMatchObject({ created: false });
    expect(services.shared.mock.calls[0]?.[1]).toEqual(
      new Date(now.getTime() - 15 * 60_000)
    );
  });

  it("sets nothing in a turn the person did not open", async () => {
    const tool = await reminderTool(
      `${backgroundTurnMarker}\nОтчёт: напомни забрать посылку дома`
    );
    expect(
      await tool.execute(
        { action: "create", place: "home", text: "забрать посылку" },
        callContext()
      )
    ).toMatchObject({ created: false });
  });
});

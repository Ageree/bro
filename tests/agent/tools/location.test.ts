import type { ModelMessage } from "ai";
import type { DynamicResolveContext, ToolContext } from "eve/tools";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type * as locationModule from "@db/services/location";
import type { readWorkspaceTimeZone } from "@db/services/user-profile";
import type { reverseGeocode } from "@agent/lib/routes/openstreetmap";
import { backgroundTurnMarker } from "@shared/chat/background-turn";

const services = vi.hoisted(() => ({
  forget: vi.fn<typeof locationModule.forgetLocation>(),
  label: vi.fn<typeof locationModule.labelPoint>(),
  latest: vi.fn<typeof locationModule.latestPosition>(),
  pilot: vi.fn<typeof locationModule.locationPilot>(),
  reverse: vi.fn<typeof reverseGeocode>(),
  setAddress: vi.fn<typeof locationModule.setPointAddress>(),
  timeZone: vi.fn<typeof readWorkspaceTimeZone>(),
}));

vi.mock("@db/services/location", () => ({
  cachedAddressNear: vi.fn<typeof locationModule.cachedAddressNear>(
    async () => undefined
  ),
  forgetLocation: services.forget,
  labelPoint: services.label,
  latestPosition: services.latest,
  locationPilot: services.pilot,
  setPointAddress: services.setAddress,
}));
vi.mock("@db/services/user-profile", () => ({
  readWorkspaceTimeZone: services.timeZone,
}));
vi.mock("@agent/lib/routes/openstreetmap", () => ({
  openStreetMapAttribution: "© OpenStreetMap",
  reverseGeocode: services.reverse,
}));

const workspaceId = "workspace:alice";
const now = new Date("2026-10-15T11:00:00.000Z");

beforeEach(() => {
  vi.useFakeTimers({ now, toFake: ["Date"] });
  services.pilot.mockReturnValue(true);
  services.timeZone.mockResolvedValue("Europe/Moscow");
  services.reverse.mockResolvedValue("Тверская улица 7, Москва");
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

function resolveContext(
  messages: ModelMessage[],
  authenticator = "authjs"
): DynamicResolveContext {
  return {
    channel: { kind: "channel:eve", metadata: {} },
    messages,
    model: null,
    session: {
      auth: { current: caller(authenticator), initiator: null },
      id: "session-1",
    },
  };
}

function callContext(authenticator = "authjs"): ToolContext {
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
      auth: { current: caller(authenticator), initiator: null },
      id: "session-1",
      turn: { id: "turn-1", sequence: 1 },
    },
    toolName: "location_now",
  };
}

async function tools(messages: ModelMessage[], authenticator = "authjs") {
  const { default: locationTools } = await import("@agent/tools/location");
  const resolve = locationTools.events["step.started"];
  return resolve
    ? await resolve({}, resolveContext(messages, authenticator))
    : null;
}

function position(
  overrides: Partial<{ recordedAt: Date; address: string | null }> = {}
) {
  return {
    live: false,
    point: {
      accuracyM: 20,
      address: null,
      createdAt: now,
      externalId: "telegram:1:2:3",
      id: "point-1",
      kind: "position" as const,
      label: null,
      lat: 55.7612,
      liveKey: null,
      lon: 37.6099,
      recordedAt: new Date(now.getTime() - 5 * 60_000),
      source: "telegram" as const,
      workspaceId,
      ...overrides,
    },
  };
}

const said = (text: string): ModelMessage[] => [
  { content: text, role: "user" },
];

describe("the geolocation tools", () => {
  it("are offered in the pilot", async () => {
    expect(Object.keys((await tools(said("где я?"))) ?? {})).toEqual([
      "location_edit",
      "location_now",
    ]);
  });

  it("are not offered outside it", async () => {
    services.pilot.mockReturnValue(false);
    expect(await tools(said("где я?"))).toBeNull();
  });

  it("tell where the person is, with the address as JSON", async () => {
    services.latest.mockResolvedValue(position());
    const set = await tools(said("где я?"));
    if (!set || !("location_now" in set))
      throw new Error("Expected the tools.");
    const result = await set.location_now.execute({}, callContext());
    expect(JSON.parse(JSON.stringify(result))).toEqual(result);
    expect(result).toMatchObject({
      known: true,
      position: {
        address: "Тверская улица 7, Москва",
        localTime: "15.10 13:55 (Europe/Moscow)",
        recordedAt: "2026-10-15T10:55:00.000Z",
      },
    });
    expect(services.setAddress).toHaveBeenCalledWith(
      "point-1",
      "Тверская улица 7, Москва"
    );
  });

  it("say an old point is where the person was, and ask for one when none", async () => {
    services.latest.mockResolvedValue(
      position({
        address: "Тверская улица 7, Москва",
        recordedAt: new Date(now.getTime() - 3 * 60 * 60_000),
      })
    );
    const set = await tools(said("где я?"));
    if (!set || !("location_now" in set))
      throw new Error("Expected the tools.");
    expect(await set.location_now.execute({}, callContext())).toHaveProperty(
      "reply",
      expect.stringContaining("where they were then")
    );
    services.latest.mockResolvedValue(undefined);
    expect(await set.location_now.execute({}, callContext())).toHaveProperty(
      "reply",
      expect.stringContaining("Ask the person to send their location")
    );
  });

  it("name a fresh point only in the person's words, in their turn", async () => {
    services.latest.mockResolvedValue(position());
    services.label.mockResolvedValue(true);
    const set = await tools(said("я припарковался здесь"));
    if (!set || !("location_edit" in set))
      throw new Error("Expected the tools.");
    expect(
      await set.location_edit.execute(
        { action: "label", label: "парковка" },
        callContext()
      )
    ).toMatchObject({ changed: true });
    expect(services.label).toHaveBeenCalledWith(
      { userId: "alice", workspaceId },
      "point-1",
      "парковка"
    );
    expect(
      await set.location_edit.execute(
        { action: "label", label: "банк" },
        callContext()
      )
    ).toMatchObject({ changed: false });
    services.latest.mockResolvedValue(
      position({ recordedAt: new Date(now.getTime() - 40 * 60_000) })
    );
    expect(
      await set.location_edit.execute(
        { action: "label", label: "парковка" },
        callContext()
      )
    ).toHaveProperty("reply", expect.stringContaining("last 15 minutes"));
    const report = await tools(
      said(`${backgroundTurnMarker}\nотчёт: я припарковался`)
    );
    if (!report || !("location_edit" in report))
      throw new Error("Expected the tools.");
    expect(
      await report.location_edit.execute(
        { action: "label", label: "парковка" },
        callContext()
      )
    ).toMatchObject({ changed: false });
  });

  it("forget, but not while Bro waits for the person's answer", async () => {
    services.forget.mockResolvedValue({ points: 3, reminders: 0 });
    const set = await tools(said("забудь, где я был"));
    if (!set || !("location_edit" in set))
      throw new Error("Expected the tools.");
    expect(
      await set.location_edit.execute({ action: "forget" }, callContext())
    ).toMatchObject({ changed: true, points: 3 });
    const waiting = await tools([
      ...said("что с историей геопозиции?"),
      {
        content: [
          {
            input: { text: "Удалить историю геопозиции или оставить?" },
            toolCallId: "s1",
            toolName: "send_message",
            type: "tool-call",
          },
        ],
        role: "assistant",
      },
      {
        content: [
          {
            output: { type: "json", value: { delivered: true } },
            toolCallId: "s1",
            toolName: "send_message",
            type: "tool-result",
          },
        ],
        role: "tool",
      },
    ]);
    if (!waiting || !("location_edit" in waiting))
      throw new Error("Expected the tools.");
    const held = await waiting.location_edit.execute(
      { action: "forget" },
      callContext()
    );
    expect(held).toHaveProperty("changed", false);
  });
});

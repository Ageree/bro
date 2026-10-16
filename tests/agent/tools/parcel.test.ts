import type { ModelMessage } from "ai";
import type { DynamicResolveContext, ToolContext } from "eve/tools";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { readPochtaParcel } from "@agent/lib/subscriptions/parcel/pochta";
import type { subscriptionsPilot } from "@agent/lib/subscriptions/pilot";
import type { reportConversations } from "@db/services/scheduled-agent-jobs";
import type { createSubscription } from "@db/services/subscriptions";
import type { readWorkspaceTimeZone } from "@db/services/user-profile";

const services = vi.hoisted(() => ({
  create: vi.fn<typeof createSubscription>(),
  pilot: vi.fn<typeof subscriptionsPilot>(),
  read: vi.fn<typeof readPochtaParcel>(),
  report: vi.fn<typeof reportConversations>(),
  timeZone: vi.fn<typeof readWorkspaceTimeZone>(),
}));

vi.mock("@agent/lib/subscriptions/parcel/pochta", () => ({
  readPochtaParcel: services.read,
}));
vi.mock("@agent/lib/subscriptions/pilot", () => ({
  subscriptionsPilot: services.pilot,
}));
vi.mock("@db/services/subscriptions", () => ({
  createSubscription: services.create,
}));
vi.mock("@db/services/scheduled-agent-jobs", () => ({
  reportConversations: services.report,
}));
vi.mock("@db/services/user-profile", () => ({
  readWorkspaceTimeZone: services.timeZone,
}));

import parcelTools from "@agent/tools/parcel";

const workspaceId = "workspace:alice";
const number = "10100012345678";

function caller() {
  return {
    attributes: { conversationChannel: "eve", workspaceId },
    authenticator: "authjs",
    principalId: "alice",
    principalType: "user" as const,
  };
}

function resolveContext(messages: ModelMessage[]): DynamicResolveContext {
  return {
    channel: { kind: "channel:eve", metadata: {} },
    messages,
    model: null,
    session: { auth: { current: caller(), initiator: null }, id: "session-1" },
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
      auth: { current: caller(), initiator: null },
      id: "session-1",
      turn: { id: "turn-1", sequence: 1 },
    },
    toolName: "parcel-watch",
  };
}

async function watch(input: { readonly number: string }, said: string) {
  const resolve = parcelTools.events["step.started"];
  const tools = resolve
    ? await resolve({}, resolveContext([{ content: said, role: "user" }]))
    : null;
  const tool =
    tools && "parcel-watch" in tools ? tools["parcel-watch"] : undefined;
  if (!tool) throw new Error("Expected parcel-watch.");
  return tool.execute(input, callContext());
}

const onItsWay = {
  expectedOn: "2026-10-17",
  kind: "parcel" as const,
  lastEvent: "Прибыло в сортировочный центр",
  lastEventAt: "2026-10-13T15:30:00.000Z",
  place: "140983, Москва",
  status: "in_transit" as const,
  storageEnding: false,
  storageUntil: null,
  title: "Посылка из Казани",
};

beforeEach(() => {
  services.pilot.mockResolvedValue(true);
  services.read.mockResolvedValue(onItsWay);
  services.create.mockImplementation(async (_scope, input) => ({
    created: true,
    // SAFETY: the tool reads only the id of the stored watch.
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- a stored row stands in.
    subscription: { id: "watch-1", ...input } as never,
  }));
  services.report.mockResolvedValue({
    delivery: {
      conversationChannel: "eve",
      conversationId: "session-1",
      replyAnchorMessageId: null,
    },
    fallbacks: [],
  });
  services.timeZone.mockResolvedValue("Europe/Moscow");
});

afterEach(() => {
  vi.clearAllMocks();
});

describe("parcel-watch", () => {
  it("watches the number the person sent, from what Russian Post says now", async () => {
    const result = await watch(
      { number: "1010 0012 3456 78" },
      "Следи за посылкой, трек 1010 0012 3456 78"
    );
    expect(result).toMatchObject({ id: "watch-1", watching: true });
    expect(services.read).toHaveBeenCalledWith(number);
    const [, created] = services.create.mock.calls[0] ?? [];
    expect(created).toMatchObject({
      dedupeKey: number,
      source: { carrier: "pochta", number, origin: "person" },
      state: { expectedOn: "2026-10-17", seen: true, status: "in_transit" },
      template: "parcel",
    });
  });

  it("finds the number the person sent behind another one", async () => {
    const result = await watch(
      { number: "8008 0123 4567 89" },
      "Посылка по заказу №12 8008 0123 4567 89, последи"
    );
    expect(result).toMatchObject({ watching: true });
    expect(services.read).toHaveBeenCalledWith("80080123456789");
  });

  it("refuses a number that is not the person's, or not Russian Post's", async () => {
    await expect(
      watch({ number: "10100099999999" }, `Следи за посылкой ${number}`)
    ).rejects.toThrow(/number must be one the person sent/u);
    // A CDEK order number is the person's, but code cannot read CDEK.
    const cdek = await watch(
      { number: "1234567890" },
      "Отследи СДЭК 1234567890"
    );
    expect(cdek).toMatchObject({ watching: false });
    expect(services.read).not.toHaveBeenCalled();
    expect(services.create).not.toHaveBeenCalled();
  });

  it("sets nothing up for a parcel already handed over", async () => {
    services.read.mockResolvedValue({
      ...onItsWay,
      lastEvent: "Вручение адресату",
      status: "delivered",
    });
    const result = await watch({ number }, `Где посылка ${number}?`);
    expect(result).toMatchObject({ watching: false });
    expect(services.create).not.toHaveBeenCalled();
  });
});

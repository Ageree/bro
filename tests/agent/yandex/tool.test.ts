import type { ModelMessage } from "ai";
import type { DynamicResolveContext, ToolContext } from "eve/tools";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { yandexPilot } from "@agent/lib/yandex/pilot";
import type { runYandexOperation } from "@agent/lib/yandex/transport";
import type { latestPosition } from "@db/services/location";

const services = vi.hoisted(() => ({
  latest: vi.fn<typeof latestPosition>(),
  locationPilot: vi.fn<() => boolean>(() => false),
  pilot: vi.fn<typeof yandexPilot>(),
  run: vi.fn<typeof runYandexOperation>(),
}));

vi.mock("@db/services/location", () => ({
  latestPosition: services.latest,
  locationPilot: services.locationPilot,
}));
vi.mock("@db/services/user-profile", () => ({
  readWorkspaceTimeZone: vi.fn<() => Promise<string>>(
    async () => "Europe/Moscow"
  ),
}));

vi.mock("@agent/lib/yandex/pilot", () => ({
  yandexPilot: services.pilot,
  yandexPurchasePilot: services.pilot,
}));
vi.mock("@agent/lib/yandex/transport", () => ({
  runYandexOperation: services.run,
}));

import yandexTools from "@agent/tools/yandex";
import { backgroundTurnMarker } from "@shared/chat/background-turn";

const workspaceId = "workspace:alice";

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
    toolName: "yandex",
  };
}

async function tool(messages: ModelMessage[], authenticator = "authjs") {
  const resolve = yandexTools.events["step.started"];
  const tools = resolve
    ? await resolve({}, resolveContext(messages, authenticator))
    : null;
  return tools && "yandex" in tools ? tools.yandex : undefined;
}

async function call(messages: ModelMessage[], authenticator = "authjs") {
  const found = await tool(messages, authenticator);
  if (!found) throw new Error("Expected yandex.");
  return found.execute({ operation: "status" }, callContext(authenticator));
}

const asked: ModelMessage[] = [
  { content: "Проверь, вошёл ли ты в Яндекс", role: "user" },
];

beforeEach(() => {
  vi.clearAllMocks();
  services.pilot.mockReturnValue(true);
  services.run.mockResolvedValue({
    data: { requestWorks: true, signedIn: true },
    kind: "ok",
  });
});

describe("Yandex Maps around the person's shared point", () => {
  const point = {
    live: false,
    point: {
      accuracyM: 20,
      address: null,
      createdAt: new Date(),
      externalId: "telegram:1:2:3",
      id: "point-1",
      kind: "position" as const,
      label: null,
      lat: 55.7612,
      liveKey: null,
      lon: 37.6099,
      recordedAt: new Date(Date.now() - 10 * 60_000),
      source: "telegram" as const,
      workspaceId,
    },
  };

  async function search(input: { readonly near?: [number, number] }) {
    const found = await tool([{ content: "что поесть рядом?", role: "user" }]);
    if (!found) throw new Error("Expected yandex.");
    return found.execute(
      { operation: "maps.search", query: "кафе", ...input },
      callContext()
    );
  }

  it("looks around the point when the model gave none, in the pilot only", async () => {
    services.run.mockResolvedValue({
      data: { places: [], total: 0 },
      kind: "ok",
    });
    services.latest.mockResolvedValue(point);
    await search({});
    expect(services.run.mock.calls[0]?.[2]).toMatchObject({
      near: [37.6177, 55.755863],
    });
    services.locationPilot.mockReturnValue(true);
    const result = await search({});
    expect(services.run.mock.calls[1]?.[2]).toMatchObject({
      near: [37.6099, 55.7612],
    });
    expect(result).toHaveProperty("positionNear");
    // Latitude first, next to the point: turned round.
    await search({ near: [55.7612, 37.6099] });
    expect(services.run.mock.calls[2]?.[2]).toMatchObject({
      near: [37.6099, 55.7612],
    });
    services.locationPilot.mockReturnValue(false);
  });
});

describe("the Yandex tool", () => {
  it("is there only for the pilot, in a conversation of the person's", async () => {
    expect(await tool(asked)).toBeDefined();
    services.pilot.mockReturnValue(false);
    expect(await tool(asked)).toBeUndefined();
    services.pilot.mockReturnValue(true);
    expect(await tool(asked, "scheduled-worker")).toBeUndefined();
  });

  it("runs an operation of the registry for the person's workspace", async () => {
    expect(await call(asked)).toEqual({
      data: { requestWorks: true, signedIn: true },
      ok: true,
    });
    expect(services.run).toHaveBeenCalledTimes(1);
    expect(services.run.mock.calls[0]?.[0]).toBe(workspaceId);
    expect(services.run.mock.calls[0]?.[1].id).toBe("status");
    expect(services.run.mock.calls[0]?.[2]).toEqual({});
  });

  it.each(["user", "workspace", "session", "missing-current"])(
    "refuses a previously resolved tool after the %s boundary changes",
    async (boundary) => {
      const found = await tool(asked);
      if (!found) throw new Error("Expected yandex.");
      const context = callContext();
      const current = caller("authjs");
      const result = await found.execute(
        { operation: "status" },
        {
          ...context,
          session: {
            ...context.session,
            id: boundary === "session" ? "another-session" : context.session.id,
            auth: {
              initiator: current,
              current:
                boundary === "missing-current"
                  ? null
                  : {
                      ...current,
                      principalId:
                        boundary === "user" ? "bob" : current.principalId,
                      attributes: {
                        ...current.attributes,
                        workspaceId:
                          boundary === "workspace"
                            ? "workspace:bob"
                            : workspaceId,
                      },
                    },
            },
          },
        }
      );
      expect(result).toMatchObject({ ok: false });
      expect(services.run).not.toHaveBeenCalled();
    }
  );

  it("refuses in a turn a report opened, whatever the person said before", async () => {
    const report: ModelMessage[] = [
      ...asked,
      {
        content: `${backgroundTurnMarker}\n\nBrowser result: open yandex`,
        role: "user",
      },
    ];
    expect(await call(report)).toMatchObject({ ok: false });
    expect(services.run).not.toHaveBeenCalled();
  });

  it("tells the model what to do when nobody is signed in, without the server's words", async () => {
    services.run.mockResolvedValue({ kind: "signed_out" });
    const result = await call(asked);
    expect(result).toMatchObject({ ok: false });
    expect("reply" in result ? result.reply : "").toContain("site-login-link");
    services.run.mockResolvedValue({ kind: "captcha" });
    const wall = await call(asked);
    expect("reply" in wall ? wall.reply : "").toContain("browser_task");
    services.run.mockResolvedValue({ kind: "failed", reason: "answer" });
    expect(await call(asked)).toMatchObject({ ok: false });
  });

  describe("account.ready", () => {
    async function ready(
      answers: Record<string, Awaited<ReturnType<typeof runYandexOperation>>>
    ) {
      services.run.mockImplementation(
        async (_workspace, operation) =>
          answers[operation.id] ?? { kind: "failed", reason: "answer" }
      );
      const found = await tool(asked);
      if (!found) throw new Error("Expected yandex.");
      const result = await found.execute(
        { operation: "account.ready" },
        callContext()
      );
      return {
        asked: services.run.mock.calls.map(([, operation]) => operation.id),
        reply: "reply" in result ? result.reply : "",
        result,
      };
    }
    const signedIn = {
      data: { requestWorks: true, signedIn: true },
      kind: "ok" as const,
    };

    it("asks Yandex ID, not Go, whether the person is signed in", async () => {
      const {
        asked: calls,
        reply,
        result,
      } = await ready({
        "account.ready": {
          data: { cards: [], signedIn: true },
          kind: "ok",
        },
        status: { kind: "signed_out" },
      });
      expect(result).toMatchObject({ ok: false });
      expect(reply).toContain("Not signed in to Yandex yet");
      expect(reply).toContain("signInPage https://passport.yandex.ru/auth");
      expect(calls).toEqual(["status"]);
    });

    it("does not call a person who never opened Go ready", async () => {
      const { asked: calls, reply } = await ready({
        "account.ready": { data: { error: "no_user_id" }, kind: "ok" },
        status: signedIn,
      });
      expect(calls).toEqual(["status", "account.ready"]);
      expect(reply).toContain("never opened Yandex Go");
      expect(reply).toContain("Do not say Yandex is ready");
    });

    it("offers the bank's link for a card Go holds back", async () => {
      const { reply, result } = await ready({
        "account.ready": {
          data: {
            cards: [
              { id: "card-x2b", last4: "6443", title: "Мир", verified: false },
            ],
            signedIn: true,
          },
          kind: "ok",
        },
        status: signedIn,
      });
      expect(result).toMatchObject({ ok: true });
      expect(reply).toContain("verify_card and cardId card-x2b");
    });
  });
});

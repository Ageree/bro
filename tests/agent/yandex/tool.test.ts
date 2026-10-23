import type { ModelMessage } from "ai";
import type { DynamicResolveContext, ToolContext } from "eve/tools";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { makeLoginHandoff } from "@agent/lib/login-handoff/make";
import type { loginHandoffPilot } from "@agent/lib/login-handoff/pilot";
import type { yandexPilot } from "@agent/lib/yandex/pilot";
import type { runYandexOperation } from "@agent/lib/yandex/transport";
import type { latestPosition } from "@db/services/location";

const services = vi.hoisted(() => ({
  afishaPilot: vi.fn<() => boolean>(() => false),
  handoffPilot: vi.fn<typeof loginHandoffPilot>(),
  latest: vi.fn<typeof latestPosition>(),
  locationPilot: vi.fn<() => boolean>(() => false),
  makeLink: vi.fn<typeof makeLoginHandoff>(),
  pilot: vi.fn<typeof yandexPilot>(),
  run: vi.fn<typeof runYandexOperation>(),
}));

vi.mock("@agent/lib/login-handoff/make", () => ({
  makeLoginHandoff: services.makeLink,
}));
vi.mock("@agent/lib/login-handoff/pilot", () => ({
  loginHandoffPilot: services.handoffPilot,
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
  afishaPurchasePilot: services.afishaPilot,
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

// Every call its own turn: a sign-in link is one per turn (`sign-in.ts`).
let turns = 0;

function callContext(authenticator = "authjs"): ToolContext {
  turns += 1;
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
      turn: { id: `turn-${String(turns)}`, sequence: 1 },
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

const signInLink = "https://bro.example/handoff/link-1";

beforeEach(() => {
  vi.clearAllMocks();
  services.handoffPilot.mockResolvedValue(true);
  services.makeLink.mockResolvedValue({ kind: "made", link: signInLink });
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

  it("sends the answer note of an operation last in its result, and none for an operation without one", async () => {
    services.run.mockResolvedValue({
      data: {
        events: [
          {
            title: "Концерт",
            url: "https://afisha.yandex.ru/moscow/concert/x",
          },
        ],
      },
      kind: "ok",
    });
    const found = await tool([{ content: "концерты на неделе", role: "user" }]);
    if (!found) throw new Error("Expected yandex.");
    const result = await found.execute(
      { category: "concert", operation: "afisha.search" },
      callContext()
    );

    expect(result).toHaveProperty("note", expect.any(String));
    expect(Object.keys(result).at(-1)).toBe("note");
    expect(await call(asked)).not.toHaveProperty("note");
  });

  // Out of the Afisha purchase pilot, yandex_purchase takes no tickets.
  it("tells only the Afisha purchase pilot to buy a zone without seats with yandex_purchase", async () => {
    services.run.mockResolvedValue({ data: { sessions: [] }, kind: "ok" });
    const note = async () => {
      const found = await tool([
        { content: "билеты на свидание", role: "user" },
      ]);
      if (!found) throw new Error("Expected yandex.");
      const result = await found.execute(
        { event: "69fcccedecb85d003180b725", operation: "afisha.prices" },
        callContext()
      );
      return JSON.stringify(result);
    };
    expect(await note()).not.toContain("yandex_purchase");
    services.afishaPilot.mockReturnValue(true);
    expect(await note()).toContain("yandex_purchase prepare service afisha");
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

  it("hands the model a Yandex sign-in link when nobody is signed in, without the server's words", async () => {
    // 23.10: a new person who asked for a taxi never named Yandex, so a link
    // left to the model waited for them to say «Яндекс».
    services.run.mockResolvedValue({ kind: "signed_out" });
    const result = await call([
      { content: "Закажи такси от Мичуринского 56", role: "user" },
    ]);
    expect(result).toMatchObject({ link: signInLink, ok: false });
    expect("reply" in result ? result.reply : "").toContain(
      "Not signed in to Yandex yet"
    );
    expect(services.makeLink).toHaveBeenCalledWith(
      expect.anything(),
      { allowedDomains: ["yandex.ru"], domain: "yandex.ru" },
      "https://passport.yandex.ru/auth"
    );
    services.makeLink.mockResolvedValue({ kind: "busy" });
    const busy = await call(asked);
    expect(busy).not.toHaveProperty("link");
    expect("reply" in busy ? busy.reply : "").toContain("window");
    services.handoffPilot.mockResolvedValue(false);
    const noLink = await call(asked);
    expect(noLink).not.toHaveProperty("link");
    expect("reply" in noLink ? noLink.reply : "").toContain("browser_task");
    services.handoffPilot.mockResolvedValue(true);
    services.makeLink.mockClear();
    // Yandex ID says the browser is signed in: the service refused alone.
    services.run.mockImplementation(async (_workspace, operation) =>
      operation.id === "status"
        ? { data: { requestWorks: true, signedIn: true }, kind: "ok" }
        : { kind: "signed_out" }
    );
    const found = await tool(asked);
    const refused = await found?.execute(
      { operation: "go.ride" },
      callContext()
    );
    expect(refused).not.toHaveProperty("link");
    expect(JSON.stringify(refused)).toContain("Do not send a sign-in link");
    expect(services.makeLink).not.toHaveBeenCalled();
    services.run.mockResolvedValue({ kind: "captcha" });
    const wall = await call(asked);
    expect("reply" in wall ? wall.reply : "").toContain("browser_task");
    services.run.mockResolvedValue({ kind: "failed", reason: "answer" });
    expect(await call(asked)).toMatchObject({ ok: false });
  });

  it("makes one sign-in link for the calls of one turn", async () => {
    services.run.mockResolvedValue({ byYandexId: true, kind: "signed_out" });
    const found = await tool(asked);
    const context = callContext();
    const [first, second] = await Promise.all([
      found?.execute({ operation: "go.ride" }, context),
      found?.execute({ operation: "status" }, context),
    ]);
    expect(first).toMatchObject({ link: signInLink });
    expect(second).toMatchObject({ link: signInLink });
    expect(services.makeLink).toHaveBeenCalledOnce();
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
        status: { byYandexId: true, kind: "signed_out" },
      });
      expect(result).toMatchObject({ link: signInLink, ok: false });
      expect(reply).toContain("Not signed in to Yandex yet");
      expect(calls).toEqual(["status"]);
    });

    it("does not call Yandex ready when the cards could not be read", async () => {
      const { asked: calls, reply } = await ready({
        "account.ready": { kind: "failed", reason: "page" },
        status: signedIn,
      });
      expect(calls).toEqual(["status", "account.ready"]);
      expect(reply).toContain("did not show the cards");
      expect(reply).toContain("do not call it ready");
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

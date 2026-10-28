import type { RouteHandlerArgs } from "eve/channels";
import type * as Undici from "undici";
import { beforeEach, describe, expect, it, vi } from "vitest";
import * as z from "zod";
import { accessScopeForUser } from "@shared/identity/access-scope";

const mocks = vi.hoisted(() => ({
  authSession: vi.fn<() => Promise<{ user: { id: string } } | null>>(),
  calendar: vi.fn<() => Promise<string | undefined>>(),
  brief: vi.fn<() => Promise<string>>(),
  quick:
    vi.fn<
      (
        scope: { workspaceId: string },
        words: string
      ) => Promise<string | undefined>
    >(),
  fetch: vi.fn<(url: string, init: { body: string }) => Promise<Response>>(),
  warm: vi.fn<(person: { city: string | undefined }) => void>(),
}));

vi.mock("undici", async (importOriginal) => ({
  ...(await importOriginal<typeof Undici>()),
  fetch: mocks.fetch,
}));
vi.mock("@db/services/auth/session", () => ({
  getAuthSession: mocks.authSession,
}));
vi.mock("@db/services/settings", () => ({
  getFormOfAddress: async () => await Promise.resolve({ formal: false }),
}));
vi.mock("@db/services/user-profile", () => ({
  readUserProfile: async () =>
    await Promise.resolve({ firstName: "Аня", timezone: "Europe/Moscow" }),
}));
vi.mock("@agent/lib/voice/brief", () => ({
  voiceBrief: mocks.brief,
  voiceCalendar: mocks.calendar,
}));
vi.mock("@agent/lib/voice/quick/answer", () => ({
  quickVoiceAnswer: mocks.quick,
  warmQuickAnswer: mocks.warm,
}));

// Alice has the fast voice with quick answers, Dan the fast voice alone, Bob
// the voice alone, Carol no voice at all.
const fast = accessScopeForUser("better-auth:alice").workspaceId;
const fastOnly = accessScopeForUser("better-auth:dan").workspaceId;
const plain = accessScopeForUser("better-auth:bob").workspaceId;
vi.stubEnv("OPENAI_API_KEY", "sk-test-voice");
vi.stubEnv("VOICE_WORKSPACES", `${fast},${fastOnly},${plain}`);
vi.stubEnv("VOICE_FAST_WORKSPACES", `${fast},${fastOnly}`);
vi.stubEnv("VOICE_QUICK_WORKSPACES", fast);
vi.stubEnv("BETTER_AUTH_URL", "https://bro.example");
const channel = (await import("@agent/channels/voice")).default;

function route(path: string) {
  const found = channel.routes.find(
    (candidate) =>
      candidate.transport !== "websocket" && candidate.path === path
  );
  if (!found || found.transport === "websocket")
    throw new Error(`No route ${path}.`);
  return found.handler;
}

const unavailable = () => {
  throw new Error("Not used by the voice routes.");
};
const context = {
  attachSession: unavailable,
  from: unavailable,
  params: {},
  requestIp: null,
  resolveSession: unavailable,
  to: unavailable,
  waitUntil: unavailable,
} satisfies RouteHandlerArgs;

async function offer(origin = "https://bro.example") {
  return await route("/eve/v1/voice/session")(
    new Request("https://bro.example/eve/v1/voice/session", {
      body: "v=0 offer",
      headers: { origin },
      method: "POST",
    }),
    context
  );
}

const sentSchema = z.object({
  session: z.object({
    delegation: z.object({
      acknowledgement_delay_ms: z.number().optional(),
      type: z.string(),
    }),
    instructions: z.string(),
    model: z.string(),
  }),
  transport: z.object({ sdp: z.string(), type: z.string() }),
});

function sentSession() {
  const [url, init] = mocks.fetch.mock.calls[0] ?? [];
  expect(url).toBe("https://api.openai.com/v1/live/sessions");
  return sentSchema.parse(JSON.parse(init?.body ?? "{}"));
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.authSession.mockResolvedValue({ user: { id: "bob" } });
  mocks.brief.mockResolvedValue("Что Бро помнит о человеке:\n- брат Лёша");
  mocks.fetch.mockResolvedValue(
    Response.json(
      { session: { id: "live_1" }, transport: { sdp: "v=0 answer" } },
      { status: 201 }
    )
  );
});

describe("opening a voice session", () => {
  it("hands the page's offer to GPT-Live with client delegation and returns its answer", async () => {
    const response = await offer();

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("application/sdp");
    expect(await response.text()).toBe("v=0 answer");
    expect(sentSession()).toMatchObject({
      session: { delegation: { type: "client" }, model: "gpt-live-1" },
      transport: { sdp: "v=0 offer", type: "webrtc" },
    });
    expect(sentSession().session.delegation).not.toHaveProperty(
      "acknowledgement_delay_ms"
    );
    expect(mocks.brief).not.toHaveBeenCalled();
  });

  it("gives the voice of the fast pilot the person's brief and holds back its filler", async () => {
    mocks.authSession.mockResolvedValue({ user: { id: "alice" } });

    await offer();

    const { session } = sentSession();
    expect(session.delegation.type).toBe("client");
    expect(session.delegation.acknowledgement_delay_ms).toBeGreaterThan(0);
    expect(session.instructions).toContain("брат Лёша");
  });

  it("asks OpenAI once more when its first answer is its own error", async () => {
    mocks.fetch.mockResolvedValueOnce(
      Response.json({ error: { message: "server error" } }, { status: 500 })
    );

    const response = await offer();

    expect(response.status).toBe(200);
    expect(await response.text()).toBe("v=0 answer");
    expect(mocks.fetch).toHaveBeenCalledTimes(2);
  });

  it("does not exist for a workspace outside the pilot, a stranger or another site", async () => {
    mocks.authSession.mockResolvedValueOnce({ user: { id: "carol" } });
    expect((await offer()).status).toBe(404);
    mocks.authSession.mockResolvedValueOnce(null);
    expect((await offer()).status).toBe(401);
    expect((await offer("https://evil.example")).status).toBe(404);
    expect(mocks.fetch).not.toHaveBeenCalled();
  });
});

describe("the quick answer", () => {
  async function ask(words: string, origin = "https://bro.example") {
    return await route("/eve/v1/voice/quick")(
      new Request("https://bro.example/eve/v1/voice/quick", {
        body: JSON.stringify({ words }),
        headers: { origin },
        method: "POST",
      }),
      context
    );
  }

  it("is offered to the page in its pilot and answers its words", async () => {
    mocks.authSession.mockResolvedValue({ user: { id: "alice" } });
    expect((await offer()).headers.get("x-bro-voice-quick")).toBe("on");
    // The home weather and rates are read as the conversation opens.
    expect(mocks.warm).toHaveBeenCalledTimes(1);
    mocks.quick.mockResolvedValueOnce("Завтра плюс восемь.");

    const answered = await ask("Какая погода завтра?");

    expect(await answered.json()).toStrictEqual({
      answer: "Завтра плюс восемь.",
    });
    expect(mocks.quick.mock.calls[0]?.[1]).toBe("Какая погода завтра?");
  });

  it("answers null when the words go to Bro", async () => {
    mocks.authSession.mockResolvedValue({ user: { id: "alice" } });
    mocks.quick.mockResolvedValueOnce(undefined);

    expect(await (await ask("Напомни позвонить маме")).json()).toStrictEqual({
      answer: null,
    });
  });

  it("does not exist outside its pilot, for a stranger or another site", async () => {
    mocks.authSession.mockResolvedValue({ user: { id: "dan" } });
    expect((await offer()).headers.get("x-bro-voice-quick")).toBeNull();
    expect(mocks.warm).not.toHaveBeenCalled();
    expect((await ask("Какая погода?")).status).toBe(404);
    mocks.authSession.mockResolvedValue({ user: { id: "alice" } });
    expect((await ask("Какая погода?", "https://evil.example")).status).toBe(
      404
    );
    expect((await ask("")).status).toBe(400);
    mocks.authSession.mockResolvedValue(null);
    expect((await ask("Какая погода?")).status).toBe(401);
    expect(mocks.quick).not.toHaveBeenCalled();
  });
});

describe("the calendar for the voice", () => {
  async function calendar() {
    return await route("/eve/v1/voice/calendar")(
      new Request("https://bro.example/eve/v1/voice/calendar"),
      context
    );
  }

  it("answers the fast pilot with the week's lines, and nothing without Google", async () => {
    mocks.authSession.mockResolvedValue({ user: { id: "alice" } });
    mocks.calendar.mockResolvedValueOnce("- вт 28.10 18:00–18:30 «Встреча»");
    const read = await calendar();
    expect(read.status).toBe(200);
    expect(await read.text()).toContain("Встреча");

    mocks.calendar.mockResolvedValueOnce(undefined);
    expect((await calendar()).status).toBe(204);
  });

  it("does not read the calendar outside the fast pilot", async () => {
    expect((await calendar()).status).toBe(404);
    expect(mocks.calendar).not.toHaveBeenCalled();
  });
});

import type { DynamicResolveContext } from "eve";
import type { ToolContext } from "eve/tools";
import type * as Undici from "undici";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";

const fetchMock = vi.hoisted(() =>
  vi.fn<
    (
      url: string,
      init: { headers: Record<string, string> }
    ) => Promise<Response>
  >()
);

vi.mock("undici", async (importOriginal) => ({
  ...(await importOriginal<typeof Undici>()),
  fetch: fetchMock,
}));

const event = {
  age_limit: "18",
  categories: [{ id: 460, name: "Концерты" }],
  description_short: "Осень &mdash; не повод грустить, когда звучит джаз!",
  ends_at: "2026-10-16T21:00:00+0300",
  id: 4_216_481,
  location: {
    address: "Старая Басманная 15Ас4\r\nВход в Сад имени Баумана",
    city: "Москва",
    country: "Россия",
  },
  name: "ДЖАЗ В УСАДЬБЕ: &quot;Грэмми Новой волны&quot;",
  registration_data: {
    is_registration_open: true,
    price_max: 2850,
    price_min: 2650,
  },
  starts_at: "2026-10-16T19:00:00+0300",
  url: "https://galereya-drugoe.timepad.ru/event/4216481/",
};

beforeEach(() => {
  vi.resetModules();
  fetchMock.mockReset();
  vi.stubEnv("TIMEPAD_API_KEY", "timepad-test-key");
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("timepad_events", () => {
  it("is offered to a person's turn only when Timepad is set up", async () => {
    expect(await resolve(personContext())).not.toBeNull();
    vi.stubEnv("TIMEPAD_API_KEY", "");
    vi.resetModules();
    expect(await resolve(personContext())).toBeNull();
  });

  it("searches by city, words, Moscow-time days and price and reads the events plainly", async () => {
    fetchMock.mockResolvedValueOnce(
      Response.json({ total: 11, values: [event] })
    );
    const result = await execute({
      city: "Москва",
      from: "2026-10-16",
      maxPriceRub: 3000,
      query: "джаз",
      to: "2026-10-18",
    });

    const [url, init] = fetchMock.mock.calls[0] ?? [];
    const sent = new URL(url ?? "");
    expect(sent.origin + sent.pathname).toBe(
      "https://api.timepad.ru/v1/events"
    );
    expect(Object.fromEntries(sent.searchParams)).toMatchObject({
      cities: "Москва",
      keywords: "джаз",
      price_max: "3000",
      sort: "+starts_at",
      starts_at_max: "2026-10-18T23:59:59+03:00",
      starts_at_min: "2026-10-16T00:00:00+03:00",
    });
    expect(init?.headers.authorization).toBe("Bearer timepad-test-key");
    expect(result).toContain("11 matching events");
    expect(result).toContain('ДЖАЗ В УСАДЬБЕ: "Грэмми Новой волны"');
    expect(result).toContain("where: Москва, Старая Басманная 15Ас4\n");
    expect(result).toContain("price: 2650–2850 ₽");
    expect(result).toContain("Осень — не повод грустить");
  });

  it("without dates looks from now in Moscow time, not at Timepad's 2050 recordings", async () => {
    vi.useFakeTimers({ now: Date.parse("2026-10-14T21:30:00Z") });
    try {
      fetchMock.mockResolvedValueOnce(Response.json({ total: 0, values: [] }));
      await execute({ query: "лекция" });
    } finally {
      vi.useRealTimers();
    }
    const sent = new URL(fetchMock.mock.calls[0]?.[0] ?? "");
    expect(sent.searchParams.get("starts_at_min")).toBe(
      "2026-10-15T00:30:00+03:00"
    );
    expect(sent.searchParams.get("starts_at_max")).toBe(
      "2026-12-14T00:30:00+03:00"
    );
  });

  it("reads one event in full by its id", async () => {
    fetchMock.mockResolvedValueOnce(
      Response.json({
        ...event,
        description_html: "<p>Свечи&nbsp;и вино.</p><p>Вход 18+</p>",
        organization: { name: "Галерея «Другое Дело»" },
        registration_data: {
          ...event.registration_data,
          price_max: 0,
          price_min: 0,
        },
      })
    );
    const result = await execute({ eventId: 4_216_481, query: "ignored" });
    const sent = new URL(fetchMock.mock.calls[0]?.[0] ?? "");
    expect(sent.pathname).toBe("/v1/events/4216481");
    expect(result).toContain("organiser: Галерея «Другое Дело»");
    expect(result).toContain("price: free");
    expect(result).toContain("about: Свечи и вино.\nВход 18+");
  });

  it("gives the model a neutral reason, not Timepad's status", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    fetchMock.mockResolvedValueOnce(new Response("nope", { status: 403 }));
    const result = await execute({ city: "Москва" });
    expect(result).toContain("could not be searched");
    expect(result).not.toContain("403");
  });
});

async function resolve(context: DynamicResolveContext) {
  const definition = (await import("@agent/tools/timepad_events")).default;
  const handler = definition.events["turn.started"];
  if (!handler) throw new Error("timepad_events resolves on turn.started.");
  return handler({}, context);
}

async function execute(input: Record<string, number | string>) {
  const tool = await resolve(personContext());
  if (!tool || !("execute" in tool)) {
    throw new Error("timepad_events resolves to a single tool.");
  }
  return z.string().parse(await tool.execute(input, toolContext()));
}

function toolContext() {
  return {
    abortSignal: new AbortController().signal,
    callId: "call-1",
    async getSandbox() {
      throw new Error("Sandbox access is outside this focused test.");
    },
    getSkill() {
      throw new Error("Skill access is outside this focused test.");
    },
    async getToken() {
      throw new Error("Token access is outside this focused test.");
    },
    requireAuth() {
      throw new Error("Authorization is outside this focused test.");
    },
    session: {
      ...personContext().session,
      turn: { id: "turn-1", sequence: 0 },
    },
    toolName: "timepad_events",
  } satisfies ToolContext;
}

function personContext() {
  return {
    channel: { kind: "channel:photon", metadata: {} },
    messages: [],
    model: null,
    session: {
      auth: {
        current: {
          attributes: { workspaceId: "personal:workspace" },
          authenticator: "photon-imessage",
          principalId: "user-1",
          principalType: "user",
        },
        initiator: null,
      },
      id: "session-1",
    },
  } satisfies DynamicResolveContext;
}

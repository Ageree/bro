import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { z } from "zod";
import * as Database from "@db";
import * as schema from "@db/schema";
import type * as EnvModule from "@shared/environment";
import { checkModelCredits, creditCheckDue } from "../credits";

const capture = vi.hoisted(() => ({
  // The check reads its settings at run time, so a test flips them in place.
  // SAFETY: The mock factory fills this object with the real environment before any test runs.
  env: {} as Record<string, number | string | undefined>,
}));

vi.mock("@shared/environment", async (importOriginal) => {
  const original = await importOriginal<typeof EnvModule>();
  Object.assign(capture.env, original.env, {
    OPENROUTER_CREDITS_ALERT_USD: 5,
    OPENROUTER_MANAGEMENT_KEY: "sk-or-management",
    TELEGRAM_OWNER_CHAT_ID: "1001",
    TELEGRAM_BOT_TOKEN: "telegram-test-token",
  });
  return { ...original, env: capture.env };
});

const client = new PGlite();
const database = drizzle(client, { schema });

beforeAll(async () => {
  await migrate(database, { migrationsFolder: "db/migrations" });
  // SAFETY: PGlite implements the same Drizzle query-builder contract used by these services; only the driver changes.
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- Exercise the real alert state with an isolated PostgreSQL-compatible test database.
  vi.spyOn(Database, "db", "get").mockReturnValue(database as never);
}, 20_000);

afterAll(async () => {
  vi.restoreAllMocks();
  await client.close();
});

const alertBodySchema = z.object({ chat_id: z.string(), text: z.string() });

function requestUrl(input: RequestInfo | URL | undefined) {
  if (input === undefined) throw new Error("The request was never sent.");
  return new Request(input).url;
}

function stubNetwork(
  credits: { total_credits: number; total_usage: number },
  network = vi.fn<typeof fetch>()
) {
  network.mockImplementation(async (input) =>
    requestUrl(input).startsWith("https://openrouter.ai/")
      ? Response.json({ data: credits })
      : Response.json({ ok: true })
  );
  vi.stubGlobal("fetch", network);
  return network;
}

function telegramCalls(network: ReturnType<typeof stubNetwork>) {
  return network.mock.calls.filter(([input]) =>
    requestUrl(input).startsWith("https://api.telegram.org/")
  ).length;
}

describe("OpenRouter credit check", () => {
  beforeEach(async () => {
    capture.env.MODEL_PROVIDER = undefined;
    capture.env.OPENROUTER_MANAGEMENT_KEY = "sk-or-management";
    await database.delete(schema.operationalAlerts);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("runs every ten minutes", () => {
    expect(creditCheckDue(new Date("2026-09-23T10:00:30Z"))).toBe(true);
    expect(creditCheckDue(new Date("2026-09-23T10:40:00Z"))).toBe(true);
    expect(creditCheckDue(new Date("2026-09-23T10:01:00Z"))).toBe(false);
  });

  it("alerts the owner in Telegram when the balance is below the threshold", async () => {
    const network = stubNetwork({ total_credits: 50, total_usage: 48.5 });

    await checkModelCredits();

    expect(network).toHaveBeenCalledTimes(2);
    const [creditsInput, creditsInit] = network.mock.calls[0] ?? [];
    expect(requestUrl(creditsInput)).toBe(
      "https://openrouter.ai/api/v1/credits"
    );
    expect(new Headers(creditsInit?.headers).get("Authorization")).toBe(
      "Bearer sk-or-management"
    );
    const [alertInput, alertInit] = network.mock.calls[1] ?? [];
    expect(requestUrl(alertInput)).toBe(
      "https://api.telegram.org/bottelegram-test-token/sendMessage"
    );
    const alertBody = z.string().parse(alertInit?.body);
    const alert = alertBodySchema.parse(JSON.parse(alertBody));
    expect(alert.chat_id).toBe("1001");
    expect(alert.text).toContain("$1.50");
  });

  it("says nothing more on the next low reading", async () => {
    const network = stubNetwork({ total_credits: 50, total_usage: 48.5 });

    await checkModelCredits(new Date("2026-09-23T10:00:00Z"));
    await checkModelCredits(new Date("2026-09-23T10:10:00Z"));
    // Two ticks reading the same balance at once still send one alert.
    await Promise.all([
      checkModelCredits(new Date("2026-09-23T10:20:00Z")),
      checkModelCredits(new Date("2026-09-23T10:20:00Z")),
    ]);

    expect(telegramCalls(network)).toBe(1);
  });

  it("repeats a low balance a day later, or sooner when it halves", async () => {
    const network = stubNetwork({ total_credits: 50, total_usage: 46 });
    await checkModelCredits(new Date("2026-09-23T10:00:00Z"));

    // $4.00 to $2.50 is not yet half.
    stubNetwork({ total_credits: 50, total_usage: 47.5 }, network);
    await checkModelCredits(new Date("2026-09-23T12:00:00Z"));
    expect(telegramCalls(network)).toBe(1);

    // $1.50 is less than half of the $4.00 the owner last heard about.
    stubNetwork({ total_credits: 50, total_usage: 48.5 }, network);
    await checkModelCredits(new Date("2026-09-23T13:00:00Z"));
    expect(telegramCalls(network)).toBe(2);

    await checkModelCredits(new Date("2026-09-24T12:00:00Z"));
    expect(telegramCalls(network)).toBe(2);
    await checkModelCredits(new Date("2026-09-24T13:10:00Z"));
    expect(telegramCalls(network)).toBe(3);
  });

  it("alerts again after the balance recovered and fell once more", async () => {
    const network = stubNetwork({ total_credits: 50, total_usage: 48 });
    await checkModelCredits(new Date("2026-09-23T10:00:00Z"));

    stubNetwork({ total_credits: 100, total_usage: 48 }, network);
    await checkModelCredits(new Date("2026-09-23T11:00:00Z"));

    stubNetwork({ total_credits: 100, total_usage: 98 }, network);
    await checkModelCredits(new Date("2026-09-23T12:00:00Z"));

    expect(telegramCalls(network)).toBe(2);
  });

  it("retries an alert Telegram did not accept", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const network = vi
      .fn<typeof fetch>()
      .mockImplementation(async (input) =>
        requestUrl(input).startsWith("https://openrouter.ai/")
          ? Response.json({ data: { total_credits: 50, total_usage: 48 } })
          : new Response(null, { status: 502 })
      );
    vi.stubGlobal("fetch", network);
    await checkModelCredits(new Date("2026-09-23T10:00:00Z"));

    stubNetwork({ total_credits: 50, total_usage: 48 }, network);
    await checkModelCredits(new Date("2026-09-23T10:10:00Z"));

    expect(telegramCalls(network)).toBe(2);
    warn.mockRestore();
  });

  it("stays quiet while the balance is above the threshold", async () => {
    const network = stubNetwork({ total_credits: 50, total_usage: 10 });

    await checkModelCredits();

    expect(network).toHaveBeenCalledOnce();
  });

  it("does nothing without a management key", async () => {
    capture.env.OPENROUTER_MANAGEMENT_KEY = undefined;
    const network = stubNetwork({ total_credits: 0, total_usage: 0 });

    await checkModelCredits();

    expect(network).not.toHaveBeenCalled();
  });

  it("logs a failed balance request instead of throwing from the schedule", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    vi.stubGlobal(
      "fetch",
      vi
        .fn<typeof fetch>()
        .mockResolvedValue(new Response(null, { status: 403 }))
    );

    await expect(checkModelCredits()).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalledOnce();
    warn.mockRestore();
  });
});

describe("RouterAI credit check", () => {
  beforeEach(async () => {
    Object.assign(capture.env, {
      MODEL_PROVIDER: "routerai",
      OPENROUTER_MANAGEMENT_KEY: "sk-or-management",
      ROUTERAI_API_KEY: "sk-rai-inference",
      ROUTERAI_BASE_URL: "https://routerai.ru/api/v1",
      ROUTERAI_CREDITS_ALERT_RUB: 300,
    });
    await database.delete(schema.operationalAlerts);
  });

  afterEach(() => {
    capture.env.MODEL_PROVIDER = undefined;
    vi.unstubAllGlobals();
  });

  function stubRouterAi(credits: number, network = vi.fn<typeof fetch>()) {
    network.mockImplementation(async (input) =>
      requestUrl(input).startsWith("https://routerai.ru/")
        ? Response.json({ data: { credits } })
        : Response.json({ ok: true })
    );
    vi.stubGlobal("fetch", network);
    return network;
  }

  it("reads the balance in roubles with the inference key", async () => {
    const network = stubRouterAi(125.5367);

    await checkModelCredits(new Date("2026-10-01T10:00:00Z"));

    expect(network).toHaveBeenCalledTimes(2);
    const [creditsInput, creditsInit] = network.mock.calls[0] ?? [];
    expect(requestUrl(creditsInput)).toBe("https://routerai.ru/api/v1/credits");
    // The OpenRouter management key is not RouterAI's.
    expect(new Headers(creditsInit?.headers).get("Authorization")).toBe(
      "Bearer sk-rai-inference"
    );
    const alert = alertBodySchema.parse(
      JSON.parse(z.string().parse(network.mock.calls[1]?.[1]?.body))
    );
    expect(alert.text).toContain("На RouterAI осталось 125.54 ₽");
    expect(alert.text).toContain("порог 300.00 ₽");
    expect(alert.text).toContain("routerai.ru/settings/billing");
  });

  it("stays quiet above the rouble threshold", async () => {
    const network = stubRouterAi(425.5);

    await checkModelCredits();

    expect(network).toHaveBeenCalledOnce();
  });

  it("keeps its alert apart from OpenRouter's", async () => {
    const network = stubRouterAi(120);
    await checkModelCredits(new Date("2026-10-01T10:00:00Z"));

    // A balance under the dollar threshold of OpenRouter would read as
    // already said if the two shared their alert.
    capture.env.MODEL_PROVIDER = undefined;
    network.mockImplementation(async (input) =>
      requestUrl(input).startsWith("https://openrouter.ai/")
        ? Response.json({ data: { total_credits: 50, total_usage: 48 } })
        : Response.json({ ok: true })
    );
    await checkModelCredits(new Date("2026-10-01T10:10:00Z"));

    expect(telegramCalls(network)).toBe(2);
  });

  it("repeats a balance that fell by half, but not by a few roubles", async () => {
    const network = stubRouterAi(80);
    await checkModelCredits(new Date("2026-10-01T10:00:00Z"));

    stubRouterAi(45, network);
    await checkModelCredits(new Date("2026-10-01T10:10:00Z"));
    expect(telegramCalls(network)).toBe(1);

    stubRouterAi(20, network);
    await checkModelCredits(new Date("2026-10-01T10:20:00Z"));
    expect(telegramCalls(network)).toBe(2);
  });
});

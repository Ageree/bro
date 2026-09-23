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
import { checkOpenRouterCredits, creditCheckDue } from "../credits";

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

    await checkOpenRouterCredits();

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

    await checkOpenRouterCredits(new Date("2026-09-23T10:00:00Z"));
    await checkOpenRouterCredits(new Date("2026-09-23T10:10:00Z"));
    // Two ticks reading the same balance at once still send one alert.
    await Promise.all([
      checkOpenRouterCredits(new Date("2026-09-23T10:20:00Z")),
      checkOpenRouterCredits(new Date("2026-09-23T10:20:00Z")),
    ]);

    expect(telegramCalls(network)).toBe(1);
  });

  it("repeats a low balance a day later, or sooner when it halves", async () => {
    const network = stubNetwork({ total_credits: 50, total_usage: 46 });
    await checkOpenRouterCredits(new Date("2026-09-23T10:00:00Z"));

    // $4.00 to $2.50 is not yet half.
    stubNetwork({ total_credits: 50, total_usage: 47.5 }, network);
    await checkOpenRouterCredits(new Date("2026-09-23T12:00:00Z"));
    expect(telegramCalls(network)).toBe(1);

    // $1.50 is less than half of the $4.00 the owner last heard about.
    stubNetwork({ total_credits: 50, total_usage: 48.5 }, network);
    await checkOpenRouterCredits(new Date("2026-09-23T13:00:00Z"));
    expect(telegramCalls(network)).toBe(2);

    await checkOpenRouterCredits(new Date("2026-09-24T12:00:00Z"));
    expect(telegramCalls(network)).toBe(2);
    await checkOpenRouterCredits(new Date("2026-09-24T13:10:00Z"));
    expect(telegramCalls(network)).toBe(3);
  });

  it("alerts again after the balance recovered and fell once more", async () => {
    const network = stubNetwork({ total_credits: 50, total_usage: 48 });
    await checkOpenRouterCredits(new Date("2026-09-23T10:00:00Z"));

    stubNetwork({ total_credits: 100, total_usage: 48 }, network);
    await checkOpenRouterCredits(new Date("2026-09-23T11:00:00Z"));

    stubNetwork({ total_credits: 100, total_usage: 98 }, network);
    await checkOpenRouterCredits(new Date("2026-09-23T12:00:00Z"));

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
    await checkOpenRouterCredits(new Date("2026-09-23T10:00:00Z"));

    stubNetwork({ total_credits: 50, total_usage: 48 }, network);
    await checkOpenRouterCredits(new Date("2026-09-23T10:10:00Z"));

    expect(telegramCalls(network)).toBe(2);
    warn.mockRestore();
  });

  it("stays quiet while the balance is above the threshold", async () => {
    const network = stubNetwork({ total_credits: 50, total_usage: 10 });

    await checkOpenRouterCredits();

    expect(network).toHaveBeenCalledOnce();
  });

  it("does nothing without a management key", async () => {
    capture.env.OPENROUTER_MANAGEMENT_KEY = undefined;
    const network = stubNetwork({ total_credits: 0, total_usage: 0 });

    await checkOpenRouterCredits();

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

    await expect(checkOpenRouterCredits()).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalledOnce();
    warn.mockRestore();
  });
});

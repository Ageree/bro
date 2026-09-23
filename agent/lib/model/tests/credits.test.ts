import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
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
    OWNER_TELEGRAM_CHAT_ID: "1001",
    TELEGRAM_BOT_TOKEN: "telegram-test-token",
  });
  return { ...original, env: capture.env };
});

const alertBodySchema = z.object({ chat_id: z.string(), text: z.string() });

function requestUrl(input: RequestInfo | URL | undefined) {
  if (input === undefined) throw new Error("The request was never sent.");
  return new Request(input).url;
}

function stubNetwork(credits: { total_credits: number; total_usage: number }) {
  const network = vi
    .fn<typeof fetch>()
    .mockImplementation(async (input) =>
      requestUrl(input).startsWith("https://openrouter.ai/")
        ? Response.json({ data: credits })
        : Response.json({ ok: true })
    );
  vi.stubGlobal("fetch", network);
  return network;
}

describe("OpenRouter credit check", () => {
  beforeEach(() => {
    capture.env.OPENROUTER_MANAGEMENT_KEY = "sk-or-management";
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("runs on the first minute of every hour", () => {
    expect(creditCheckDue(new Date("2026-09-23T10:00:30Z"))).toBe(true);
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

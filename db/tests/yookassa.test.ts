import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";

const fetchMock = vi.fn<typeof fetch>();

/**
 * The environment is validated once per module registry, so the credentials
 * have to be in place before the client is imported.
 */
async function yooKassaClient(
  credentials: { readonly secretKey: string; readonly shopId: string } = {
    secretKey: "test_secret",
    shopId: "123456",
  }
) {
  vi.stubEnv("YOOKASSA_SHOP_ID", credentials.shopId);
  vi.stubEnv("YOOKASSA_SECRET_KEY", credentials.secretKey);
  vi.resetModules();
  return await import("@db/services/yookassa");
}

function jsonResponse(body: string, status = 200) {
  return new Response(body, {
    headers: { "content-type": "application/json" },
    status,
  });
}

beforeEach(() => {
  vi.stubGlobal("fetch", fetchMock);
  fetchMock.mockReset();
});

afterEach(() => {
  // Only these two: `unstubAllEnvs` would also drop the shared test
  // environment this file's env module still needs to validate.
  vi.stubEnv("YOOKASSA_SHOP_ID", "");
  vi.stubEnv("YOOKASSA_SECRET_KEY", "");
  vi.unstubAllGlobals();
});

describe("YooKassa client", () => {
  it("creates a redirect payment for one workspace", async () => {
    const { createYooKassaPayment } = await yooKassaClient();
    fetchMock.mockResolvedValue(
      jsonResponse(
        JSON.stringify({
          confirmation: { confirmation_url: "https://yoomoney.test/confirm" },
          id: "2f0a-pending",
          status: "pending",
        })
      )
    );

    const created = await createYooKassaPayment(
      "workspace:alice",
      "https://bro.example/workspace?paid=1"
    );

    expect(created.confirmationUrl).toBe("https://yoomoney.test/confirm");
    const [url, init] = fetchMock.mock.calls[0] ?? [];
    expect(url).toBe("https://api.yookassa.ru/v3/payments");
    const headers = new Headers(init?.headers);
    expect(headers.get("authorization")).toBe(
      `Basic ${Buffer.from("123456:test_secret").toString("base64")}`
    );
    // Without it a retried create buys a second month.
    expect(headers.get("idempotence-key")).toMatch(/^[\da-f-]{36}$/u);
    expect(JSON.parse(z.string().parse(init?.body))).toEqual({
      amount: { currency: "RUB", value: "2000.00" },
      capture: true,
      confirmation: {
        return_url: "https://bro.example/workspace?paid=1",
        type: "redirect",
      },
      description: "Бро — месяц доступа",
      metadata: { workspaceId: "workspace:alice" },
    });
  });

  it("refuses a create that came back without a confirmation URL", async () => {
    const { createYooKassaPayment } = await yooKassaClient();
    fetchMock.mockResolvedValue(
      jsonResponse(JSON.stringify({ id: "2f0a-pending", status: "pending" }))
    );

    await expect(
      createYooKassaPayment("workspace:alice", "https://bro.example/workspace")
    ).rejects.toThrow(/confirmation URL/u);
  });

  it("reads a payment by id and reports a missing one as nothing", async () => {
    const { paymentAmountRub, readYooKassaPayment } = await yooKassaClient();
    fetchMock.mockResolvedValue(
      jsonResponse(
        JSON.stringify({
          amount: { currency: "RUB", value: "2000.00" },
          id: "2f0a-succeeded",
          metadata: { workspaceId: "workspace:alice" },
          status: "succeeded",
        })
      )
    );

    const payment = await readYooKassaPayment("2f0a-succeeded");
    expect(payment?.status).toBe("succeeded");
    expect(payment?.metadata?.workspaceId).toBe("workspace:alice");
    expect(payment && paymentAmountRub(payment)).toBe(2000);
    expect(fetchMock.mock.calls[0]?.[0]).toBe(
      "https://api.yookassa.ru/v3/payments/2f0a-succeeded"
    );

    fetchMock.mockResolvedValue(
      jsonResponse(JSON.stringify({ type: "error" }), 404)
    );
    await expect(readYooKassaPayment("missing")).resolves.toBeNull();

    fetchMock.mockResolvedValue(
      jsonResponse(JSON.stringify({ type: "error" }), 500)
    );
    await expect(readYooKassaPayment("broken")).rejects.toThrow(
      /lookup failed/u
    );
  });

  it("runs in free mode when either credential is missing", async () => {
    const configured = await yooKassaClient();
    expect(configured.yooKassaConfigured()).toBe(true);

    const free = await yooKassaClient({ secretKey: "", shopId: "123456" });
    expect(free.yooKassaConfigured()).toBe(false);
    await expect(free.readYooKassaPayment("2f0a")).rejects.toThrow(
      /not configured/u
    );
  });
});

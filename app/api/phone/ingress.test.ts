import { createHmac } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { z } from "zod";

vi.mock("@db/services/phone", () => ({
  acceptInboundCall: vi.fn<() => Promise<{ row: { id: string } }>>(
    async () => ({ row: { id: "inbound-row-1" } })
  ),
  enqueuePhoneEvent: vi.fn<() => void>(),
  phonePilot: vi.fn<() => boolean>(() => true),
  readInboundPhoneScope: vi.fn<() => Promise<{ workspaceId: string }>>(
    async () => ({ workspaceId: "workspace-1" })
  ),
  readPhoneNumber: vi.fn<() => Promise<{ phoneNumberId: string }>>(
    async () => ({ phoneNumberId: "phone-number-1" })
  ),
}));
vi.mock("@shared/phone/elevenlabs", () => ({
  requirePhoneAgentReady: vi.fn<() => Promise<{ maxDurationSeconds: number }>>(
    async () => ({ maxDurationSeconds: 300 })
  ),
}));

const initSecret = "local-phone-init-test-secret-32-bytes";
vi.stubEnv("TELEGRAM_BOT_USERNAME", "phone_test_bot");
vi.stubEnv("PHONE_INIT_SECRET", initSecret);
vi.stubEnv("PHONE_AGENT_ID", "agent_bro");
const { boundedPhoneBody, phoneInitiation, verifyPhoneSignature } =
  await import("./ingress");
const secret = "local-phone-webhook-test-secret-32-bytes";
const now = 1_800_000_000_000;

function signed(body: Buffer, timestamp = now / 1000) {
  const stamp = String(timestamp);
  return `t=${stamp},v0=${createHmac("sha256", secret).update(`${stamp}.`).update(body).digest("hex")}`;
}

describe("phone raw HTTP authentication", () => {
  it("verifies the actual raw bytes and timestamp before any JSON parsing", () => {
    const body = Buffer.from("this is not JSON");
    expect(verifyPhoneSignature(body, signed(body), secret, now)).toBe(true);
    expect(
      verifyPhoneSignature(
        Buffer.from("different bytes"),
        signed(body),
        secret,
        now
      )
    ).toBe(false);
    expect(
      verifyPhoneSignature(body, signed(body, now / 1000 - 301), secret, now)
    ).toBe(false);
    expect(
      verifyPhoneSignature(body, signed(body, now / 1000 + 301), secret, now)
    ).toBe(false);
    expect(verifyPhoneSignature(body, signed(body), "other-secret", now)).toBe(
      false
    );
    expect(verifyPhoneSignature(body, null, secret, now)).toBe(false);
  });

  it("bounds a real streamed request body even without content-length", async () => {
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(Buffer.from("1234"));
        controller.enqueue(Buffer.from("5678"));
        controller.close();
      },
    });
    const init = { method: "POST", body: stream, duplex: "half" };
    await expect(
      boundedPhoneBody(
        new Request("http://localhost/api/phone/post-call", init),
        6
      )
    ).rejects.toThrow("Body too large");
  });

  it("rejects unauthenticated initiation before parsing attacker input or contacting a provider", async () => {
    const response = await phoneInitiation(
      new Request("http://localhost/api/phone/initiation", {
        method: "POST",
        body: "invalid JSON",
      })
    );
    expect(response.status).toBe(401);
  });
});

describe("phone inbound greeting and prompt", () => {
  it("greets without calling itself AI or announcing recording, and keeps the call open until goodbye", async () => {
    const response = await phoneInitiation(
      new Request("http://localhost/api/phone/initiation", {
        method: "POST",
        headers: { "x-phone-init-secret": initSecret },
        body: JSON.stringify({
          called_number: "+74950000001",
          agent_id: "agent_bro",
          conversation_id: "conversation-inbound-1",
          caller_id: "+79990000000",
        }),
      })
    );
    expect(response.status).toBe(200);
    const { agent } = z
      .object({
        conversation_config_override: z.object({
          agent: z.object({
            first_message: z.string(),
            prompt: z.object({ prompt: z.string() }),
          }),
        }),
      })
      .parse(await response.json()).conversation_config_override;

    expect(agent.first_message).toBe(
      "Здравствуйте! Это Бро, помощник владельца этого номера. Могу принять сообщение для него. Как к вам обращаться и что передать?"
    );
    expect(agent.first_message).not.toContain("ИИ");
    expect(agent.first_message).not.toContain("записыв");

    const { prompt } = agent.prompt;
    expect(prompt).toContain("не утверждай, что ты человек");
    expect(prompt).toContain(
      "голосовой ИИ-помощник, оператор связи может записывать звонок, а краткое содержание сохраняется для отчёта владельцу"
    );
    expect(prompt).toContain("спроси, не хочет ли он что-нибудь добавить");
    expect(prompt).toContain("Никогда не обрывай собеседника на полуслове");
    expect(prompt).toContain("никогда не вызывай end_call в том же ходе");
    expect(prompt).toContain("ГЛАВНОЕ ПРАВИЛО");
    expect(prompt.indexOf("ГЛАВНОЕ ПРАВИЛО")).toBeLessThan(200);
    expect(prompt).toContain("дождись его ответа и затем вызови end_call");
    expect(prompt).not.toContain("сразу вызови end_call");
  });
});

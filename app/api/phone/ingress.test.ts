import { createHmac } from "node:crypto";
import { describe, expect, it, vi } from "vitest";

vi.stubEnv("TELEGRAM_BOT_USERNAME", "phone_test_bot");
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

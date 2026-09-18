import type { AdapterPostableMessage } from "chat";
import { APIError } from "better-auth/api";
import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";

const mocks = vi.hoisted(() => ({
  openDM: vi.fn<(userId: string) => Promise<string>>(),
  postMessage:
    vi.fn<
      (
        threadId: string,
        message: AdapterPostableMessage
      ) => Promise<{ id: string }>
    >(),
}));

vi.mock("@photon-ai/chat-adapter-imessage", () => ({
  createiMessageAdapter: () => ({
    openDM: mocks.openDM,
    postMessage: mocks.postMessage,
  }),
}));

const photonApiErrorSchema = z.object({
  code: z.string(),
  message: z.string(),
  photonError: z.object({
    code: z.string(),
    kind: z.string(),
    message: z.string(),
  }),
});

describe("Photon phone authentication", () => {
  afterEach(() => {
    vi.clearAllMocks();
    vi.resetModules();
  });

  it("refuses to send a code before Photon is configured", async () => {
    vi.stubEnv("IMESSAGE_PROJECT_ID", "");
    vi.stubEnv("IMESSAGE_PROJECT_SECRET", "");

    const { sendPhoneCode } = await import("@db/services/auth");

    const error: unknown = await sendPhoneCode({
      code: "123456",
      to: "+12025550123",
    }).catch((cause: unknown) => cause);

    expect(error).toBeInstanceOf(APIError);
    if (!(error instanceof APIError)) throw new TypeError("Expected APIError");
    expect(z.object({ code: z.string() }).parse(error.body).code).toBe(
      "IMESSAGE_NOT_CONFIGURED"
    );
    expect(mocks.openDM).not.toHaveBeenCalled();
  });

  it("preserves provider diagnostics and returns actionable client copy", async () => {
    vi.stubEnv("IMESSAGE_PROJECT_ID", "photon-test-project");
    vi.stubEnv("IMESSAGE_PROJECT_SECRET", "photon-test-secret");
    mocks.openDM.mockRejectedValue(
      Object.assign(new Error("Handle is not on iMessage"), {
        code: "invalidArgument",
        name: "ValidationError",
      })
    );

    const { sendPhoneCode } = await import("@db/services/auth");
    const error: unknown = await sendPhoneCode({
      code: "123456",
      to: "+12025550123",
    }).catch((cause: unknown) => cause);

    expect(error).toBeInstanceOf(APIError);
    if (!(error instanceof APIError)) throw new TypeError("Expected APIError");

    const body = photonApiErrorSchema.parse(error.body);
    expect(body).toMatchObject({
      code: "IMESSAGE_RECIPIENT_UNREACHABLE",
      photonError: {
        code: "invalidArgument",
        kind: "ValidationError",
        message: "Handle is not on iMessage",
      },
    });
    expect(body.message).toContain("not reachable on iMessage");
  });

  it("reports an unreachable Photon project separately from a rejected send", async () => {
    vi.stubEnv("IMESSAGE_PROJECT_ID", "photon-test-project");
    vi.stubEnv("IMESSAGE_PROJECT_SECRET", "photon-test-secret");
    mocks.openDM.mockRejectedValue(new Error("network unreachable"));

    const { sendPhoneCode } = await import("@db/services/auth");
    const error: unknown = await sendPhoneCode({
      code: "123456",
      to: "+12025550123",
    }).catch((cause: unknown) => cause);

    expect(error).toBeInstanceOf(APIError);
    if (!(error instanceof APIError)) throw new TypeError("Expected APIError");
    expect(z.object({ code: z.string() }).parse(error.body).code).toBe(
      "IMESSAGE_PROJECT_UNAVAILABLE"
    );
  });

  it("sends the sign-in code over iMessage", async () => {
    vi.stubEnv("IMESSAGE_PROJECT_ID", "photon-test-project");
    vi.stubEnv("IMESSAGE_PROJECT_SECRET", "photon-test-secret");
    mocks.openDM.mockResolvedValue("imessage:iMessage;-;+12025550123");
    mocks.postMessage.mockResolvedValue({ id: "message-1" });

    const { sendPhoneCode } = await import("@db/services/auth");
    await sendPhoneCode({ code: "123456", to: "+12025550123" });

    expect(mocks.postMessage).toHaveBeenCalledExactlyOnceWith(
      "imessage:iMessage;-;+12025550123",
      {
        raw: "Local Vault Assistant sign-in code: 123456. Expires in 5 minutes.",
      }
    );
  });
});

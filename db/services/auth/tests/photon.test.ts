import type {
  CreateiMessageAdapterOptions,
  iMessageCredentialProvider,
} from "@photon-ai/chat-adapter-imessage";
import type { AdapterPostableMessage } from "chat";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  PhotonDeliveryError,
  photonOtpFailure,
  sendPhotonText,
} from "@db/services/auth/photon";

const mocks = vi.hoisted(() => ({
  // SAFETY: The mocked adapter factory replaces this value on first delivery.
  credentials: undefined as iMessageCredentialProvider | undefined,
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
  createiMessageAdapter(config: CreateiMessageAdapterOptions) {
    mocks.credentials = config.credentials;
    return { openDM: mocks.openDM, postMessage: mocks.postMessage };
  },
}));

afterEach(() => {
  vi.clearAllMocks();
});

describe("Photon delivery", () => {
  it("opens the conversation and posts the code as plain text", async () => {
    mocks.openDM.mockResolvedValue("imessage:iMessage;-;+12025550123");
    mocks.postMessage.mockResolvedValue({ id: "message-1" });

    await sendPhotonText({
      message: "Your code is 123456.",
      to: "+12025550123",
    });

    expect(mocks.openDM).toHaveBeenCalledExactlyOnceWith("+12025550123");
    expect(mocks.postMessage).toHaveBeenCalledExactlyOnceWith(
      "imessage:iMessage;-;+12025550123",
      { raw: "Your code is 123456." }
    );
  });

  it("resolves project credentials lazily from the environment", async () => {
    mocks.openDM.mockResolvedValue("imessage:iMessage;-;+12025550123");
    mocks.postMessage.mockResolvedValue({ id: "message-1" });

    await sendPhotonText({ message: "Your code is 1.", to: "+12025550123" });

    const credentials = mocks.credentials;
    if (!credentials) {
      throw new Error("The adapter must receive a credential provider.");
    }
    expect(() => credentials()).toThrow(/IMESSAGE_PROJECT_ID/u);
  });

  it("preserves the provider's failure classification", async () => {
    mocks.openDM.mockRejectedValue(
      Object.assign(new Error("Unknown handle"), {
        code: "notFound",
        name: "NotFoundError",
      })
    );

    const error = await capturePhotonDeliveryError();

    expect(error).toMatchObject({
      code: "notFound",
      kind: "NotFoundError",
      photonMessage: "Unknown handle",
    });
    expect(error.message).toContain("NotFoundError");
  });

  it("does not disguise an unrelated failure as a provider failure", async () => {
    mocks.openDM.mockRejectedValue(new Error("network unreachable"));

    await expect(
      sendPhotonText({ message: "Your code is 1.", to: "+12025550123" })
    ).rejects.not.toBeInstanceOf(PhotonDeliveryError);
  });

  it.each([
    ["AuthenticationError", "IMESSAGE_PROJECT_NOT_AUTHORIZED", "credentials"],
    ["ConnectionError", "IMESSAGE_SERVICE_UNAVAILABLE", "did not respond"],
    ["NotFoundError", "IMESSAGE_RECIPIENT_UNKNOWN", "registered with iMessage"],
    ["RateLimitError", "IMESSAGE_RATE_LIMITED", "Wait a moment"],
    ["ValidationError", "IMESSAGE_RECIPIENT_UNREACHABLE", "not reachable"],
    ["IMessageError", "IMESSAGE_DELIVERY_FAILED", "could not send"],
  ])("maps %s to actionable OTP copy", (kind, expectedCode, copy) => {
    const failure = photonOtpFailure(new PhotonDeliveryError({ kind }));

    expect(failure.code).toBe(expectedCode);
    expect(failure.message).toContain(copy);
  });
});

async function capturePhotonDeliveryError(): Promise<PhotonDeliveryError> {
  try {
    await sendPhotonText({
      message: "Your code is 123456.",
      to: "+12025550123",
    });
  } catch (error) {
    if (error instanceof PhotonDeliveryError) return error;
    throw error;
  }
  throw new Error("Expected Photon delivery to fail.");
}

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

  it.each([
    ["AuthenticationError", "IMESSAGE_PROJECT_NOT_AUTHORIZED", "не работает"],
    ["NotFoundError", "IMESSAGE_RECIPIENT_UNKNOWN", "Проверь номер"],
    ["ValidationError", "IMESSAGE_RECIPIENT_UNREACHABLE", "не принимает"],
    ["IMessageError", "IMESSAGE_DELIVERY_FAILED", "Не удалось отправить"],
  ])("maps %s to actionable OTP copy", (kind, expectedCode, copy) => {
    const failure = photonOtpFailure(new PhotonDeliveryError({ kind }));

    expect(failure.code).toBe(expectedCode);
    expect(failure.message).toContain(copy);
  });
});

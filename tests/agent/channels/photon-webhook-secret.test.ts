import type { PhotonIMessageChannelConfig } from "eve/channels/photon";
import { describe, expect, it, vi } from "vitest";
import type * as EnvModule from "@shared/environment";
// oxlint-disable-next-line import/no-unassigned-import -- Loads the production module so the mocked channel factory can capture its configuration.
import "@agent/channels/photon";

const capture = vi.hoisted(() => ({
  // SAFETY: The mocked channel factory replaces this value during module loading.
  config: undefined as PhotonIMessageChannelConfig | undefined,
}));

vi.mock("@shared/environment", async (importOriginal) => {
  const original = await importOriginal<typeof EnvModule>();
  return {
    ...original,
    env: {
      ...original.env,
      IMESSAGE_PROJECT_ID: "photon-test-project",
      IMESSAGE_PROJECT_SECRET: "photon-test-secret",
      IMESSAGE_WEBHOOK_SECRET: undefined,
    },
  };
});
vi.mock(import("eve/channels/photon"), async (importOriginal) => {
  const original = await importOriginal();
  return {
    ...original,
    photonIMessageChannel(config: PhotonIMessageChannelConfig) {
      capture.config = config;
      return original.photonIMessageChannel(config);
    },
  };
});

describe("Photon webhook verification", () => {
  it("rejects deliveries when the signing secret is missing", () => {
    const verifier = capture.config?.webhookVerifier;
    if (!verifier) {
      throw new Error("The Photon channel must verify inbound webhooks.");
    }

    expect(capture.config?.webhookSecret).toBeUndefined();
    expect(() =>
      verifier(
        new Request("https://assistant.example/eve/v1/photon", {
          body: "{}",
          method: "POST",
        }),
        "{}"
      )
    ).toThrow(/IMESSAGE_WEBHOOK_SECRET/u);
  });

  it("does not resolve project credentials until the adapter needs them", () => {
    expect(capture.config?.credentials).toBeTypeOf("function");
  });
});

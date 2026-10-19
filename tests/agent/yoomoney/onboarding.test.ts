import type { ModelMessage } from "ai";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type * as Onboarding from "@db/services/yoomoney/onboarding";

const services = vi.hoisted(() => ({
  claim: vi.fn<typeof Onboarding.claimYoomoneyOnboardingResumes>(),
  release: vi.fn<typeof Onboarding.releaseYoomoneyOnboardingResume>(),
}));

vi.mock("@db/services/yoomoney/onboarding", () => ({
  claimYoomoneyOnboardingResumes: services.claim,
  releaseYoomoneyOnboardingResume: services.release,
}));

import {
  openedByYoomoneyResume,
  resumedYoomoneyOnboardingId,
  resumeYoomoneyOnboardings,
} from "@agent/lib/yoomoney/onboarding";

const id = "0f9f7a5e-5c1d-4f0b-9a52-2b6f0d3c1e11";

const send = vi.fn<
  (
    message: string,
    options: {
      auth: Parameters<typeof resumedYoomoneyOnboardingId>[0];
      turnPolicy: string;
    }
  ) => Promise<{ status: string }>
>();
const delivery = {
  attachSession: vi.fn<(sessionId: string) => { send: typeof send }>(() => ({
    send,
  })),
  to: vi.fn<() => { send: typeof send }>(() => ({ send })),
};

beforeEach(() => {
  vi.clearAllMocks();
  send.mockResolvedValue({ status: "accepted" });
  services.claim.mockResolvedValue([
    {
      id,
      workspaceId: "workspace:alice",
      userId: "alice",
      conversationChannel: "eve",
      conversationId: "session-1",
      deviceHash: null,
      expiresAt: new Date(),
      createdAt: new Date(),
      connectedAt: new Date(),
      readyAt: new Date(),
      resumedAt: new Date(),
    },
  ]);
});

describe("carrying on in the chat once the wallet is connected", () => {
  it("opens a turn of Bro's own that may prepare, and no later delivery under its kept caller", async () => {
    // @ts-expect-error -- the schedule's delivery handles, as eve passes them, are wider than these fakes.
    await resumeYoomoneyOnboardings(delivery, new Date());
    expect(delivery.attachSession).toHaveBeenCalledWith("session-1");
    const [message, options] = send.mock.calls[0] ?? [];
    if (message === undefined || options === undefined) {
      throw new Error("Expected the turn.");
    }
    expect(options.turnPolicy).toBe("queue");
    expect(resumedYoomoneyOnboardingId(options.auth)).toBe(id);

    const asked: ModelMessage[] = [
      { role: "user", content: "Положи 100 рублей на МегаФон 9261234567" },
      { role: "assistant", content: "Подключи ЮMoney — это минута." },
      { role: "user", content: message },
    ];
    expect(openedByYoomoneyResume(asked)).toBe(true);
    // A task's report eve delivers next, its text a file's: not this turn.
    expect(
      openedByYoomoneyResume([
        ...asked,
        {
          role: "user",
          content: `Background task task_1 (task) is completed.\n\n${message}`,
        },
      ])
    ).toBe(false);
    expect(services.release).not.toHaveBeenCalled();
  });

  it("gives a turn that could not be sent to the next tick", async () => {
    send.mockRejectedValue(new Error("The session is gone."));
    // @ts-expect-error -- the schedule's delivery handles, as eve passes them, are wider than these fakes.
    await resumeYoomoneyOnboardings(delivery, new Date());
    expect(services.release).toHaveBeenCalledWith(id, expect.any(Date));
  });
});

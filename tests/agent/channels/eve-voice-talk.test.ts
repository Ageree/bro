import type { EveChannelInput } from "eve/channels/eve";
import { afterEach, describe, expect, it, vi } from "vitest";
import type * as ScopeService from "@db/services/scope";
import { accessScopeForUser } from "@shared/identity/access-scope";
import {
  clearSandboxSettings,
  importWithSandbox,
} from "@tests/helpers/sandbox";

const capture = vi.hoisted(() => ({
  configs: new Array<EveChannelInput>(),
}));

vi.mock(import("eve/channels/eve"), async (importOriginal) => {
  const original = await importOriginal();
  return {
    ...original,
    eveChannel(config: EveChannelInput) {
      capture.configs.push(config);
      return original.eveChannel(config);
    },
  };
});
vi.mock("@db/services/scope", async (importOriginal) => ({
  ...(await importOriginal<typeof ScopeService>()),
  claimWorkspaceIntroduction: async () => await Promise.resolve(false),
}));

const scope = accessScopeForUser("better-auth:user-1");
const context = {
  eve: {
    caller: {
      attributes: {
        conversationChannel: "eve",
        phoneNumber: "+12025550123",
        workspaceId: scope.workspaceId,
      },
      authenticator: "authjs",
      principalId: scope.userId,
      principalType: "user",
    },
    request: new Request("https://assistant.example/eve/v1/session"),
  },
} as const;

async function onMessageWith(overrides: Readonly<Record<string, string>>) {
  capture.configs.length = 0;
  await importWithSandbox(
    async () => await import("@agent/channels/eve"),
    overrides
  );
  const onMessage = capture.configs[0]?.onMessage;
  if (!onMessage) throw new Error("The Eve channel must prepare messages.");
  return onMessage;
}

afterEach(() => {
  clearSandboxSettings();
  vi.resetModules();
});

// Each case loads the channel's whole module graph afresh.
describe("words from the voice page", { timeout: 60_000 }, () => {
  const base = {
    OPENAI_API_KEY: "sk-test-voice",
    OPENROUTER_API_KEY: "openrouter-test-key",
  };

  it("tell the model its reply will be heard, in the voice pilot", async () => {
    const onMessage = await onMessageWith({
      ...base,
      VOICE_WORKSPACES: scope.workspaceId,
    });

    const result = await onMessage(context, "[голосом] что у меня завтра?");

    expect(result.context?.at(-1)).toContain("услышит голосом");
  });

  it("are an ordinary message outside the pilot", async () => {
    const onMessage = await onMessageWith({ ...base, VOICE_WORKSPACES: "" });

    const result = await onMessage(context, "[голосом] что у меня завтра?");

    expect(result.context).toEqual([]);
  });
});

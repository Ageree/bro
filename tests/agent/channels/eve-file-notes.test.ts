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
const caller = {
  attributes: {
    conversationChannel: "eve",
    phoneNumber: "+12025550123",
    workspaceId: scope.workspaceId,
  },
  authenticator: "authjs",
  principalId: scope.userId,
  principalType: "user",
} as const;

/** The channel's `onMessage` as a deployment with these settings has it. */
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

const message = [
  { text: "заполни анкету", type: "text" as const },
  {
    data: Buffer.from("%PDF-1.7\n%âãÏÓ\n", "latin1").toString("base64"),
    filename: "Анкета секция №2.pdf",
    mediaType: "application/pdf",
    type: "file" as const,
  },
];

const context = {
  eve: {
    caller,
    request: new Request("https://assistant.example/eve/v1/session"),
  },
};

afterEach(() => {
  clearSandboxSettings();
  vi.resetModules();
});

// Each case loads the channel's whole module graph afresh.
describe("the web chat's file names", { timeout: 60_000 }, () => {
  const base = { OPENROUTER_API_KEY: "openrouter-test-key" };

  it("names the person's files last in the turn's context in the files pilot", async () => {
    const onMessage = await onMessageWith({
      ...base,
      SANDBOX_WORKSPACES: scope.workspaceId,
      TASK_FILES_WORKSPACES: scope.workspaceId,
    });

    const result = await onMessage(context, message);

    expect(result.context?.at(-1)?.split("\n").slice(1)).toEqual([
      "[файл: Анкета секция №2.pdf (application/pdf)]",
    ]);
  });

  it("adds nothing outside the pilot", async () => {
    const onMessage = await onMessageWith({
      ...base,
      SANDBOX_WORKSPACES: scope.workspaceId,
      TASK_FILES_WORKSPACES: "",
    });

    const result = await onMessage(context, message);

    expect(result.context).toEqual([]);
  });
});

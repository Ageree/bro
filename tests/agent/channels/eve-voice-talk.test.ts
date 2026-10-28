import type { EveChannelInput } from "eve/channels/eve";
import { afterEach, describe, expect, it, vi } from "vitest";
import type * as ScopeService from "@db/services/scope";
import type * as UserProfile from "@db/services/user-profile";
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
vi.mock("@db/services/work-log", () => ({
  lastWorkLineOfSession: async () => {
    await Promise.resolve();
    return undefined;
  },
  readWorkLines: async () =>
    await Promise.resolve([
      {
        createdAt: new Date("2026-10-28T11:00:00Z"),
        files: ["Договор.pdf"],
        role: "person",
        sessionId: "docs",
        text: "Разбери договор",
        turnId: "turn_1",
      },
      {
        createdAt: new Date("2026-10-28T11:01:00Z"),
        files: [],
        role: "bro",
        sessionId: "docs",
        text: "Штраф — 0,1% за каждый час сверх шести.",
        turnId: "turn_1",
      },
    ]),
}));
vi.mock("@db/services/user-profile", async (importOriginal) => ({
  ...(await importOriginal<typeof UserProfile>()),
  readWorkspaceTimeZone: async () => await Promise.resolve("Europe/Moscow"),
}));
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

    expect(result.context).toHaveLength(1);
  });

  // 28.10: /talk opens a new chat each time, and Bro's turns from it knew
  // nothing of a contract it had read in another chat.
  it("carry what Bro did in the other chats, in the work log pilot", async () => {
    const onMessage = await onMessageWith({
      ...base,
      VOICE_WORKSPACES: scope.workspaceId,
      WORK_LOG_WORKSPACES: scope.workspaceId,
    });

    // /talk sends to the chat it has just made empty (`use-voice-talk.ts`).
    const result = await onMessage(
      { ...context, eve: { ...context.eve, sessionId: "voice-chat" } },
      "[голосом] какой там штраф?"
    );

    expect(result.context).toHaveLength(2);
    expect(result.context?.[1]).toContain(
      "просьба «Разбери договор» (файлы: Договор.pdf) → Бро: «Штраф — 0,1% за каждый час сверх шести.»"
    );
  });

  it("are an ordinary message outside the pilot", async () => {
    const onMessage = await onMessageWith({ ...base, VOICE_WORKSPACES: "" });

    const result = await onMessage(context, "[голосом] что у меня завтра?");

    expect(result.context).toEqual([]);
  });
});

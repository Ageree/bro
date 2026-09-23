import type { DynamicResolveContext } from "eve/instructions";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { hasOtherConversations } from "@db/services/chats";
import acquaintance from "@agent/instructions/70-acquaintance";

const mocks = vi.hoisted(() => ({
  hasOtherConversations: vi.fn<typeof hasOtherConversations>(),
}));

vi.mock("@db/services/chats", () => ({
  hasOtherConversations: mocks.hasOtherConversations,
}));

const resolve = acquaintance.events["turn.started"];
if (!resolve) {
  throw new Error("Acquaintance must be resolved at the start of a turn.");
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("acquaintance context", () => {
  // A fresh web chat of a long-standing account used to open with
  // «привет, я бро — беру на себя разную рутину…».
  it("tells the model a new chat is not a new acquaintance", async () => {
    mocks.hasOtherConversations.mockResolvedValue(true);

    const selected = await resolve({}, dynamicContext("authjs"));

    expect(mocks.hasOtherConversations).toHaveBeenCalledExactlyOnceWith(
      { userId: "user-1", workspaceId: "personal:workspace" },
      "session-new"
    );
    expect(selected?.content).toContain("не представляйся");
  });

  it("stays out of the workspace's very first conversation", async () => {
    mocks.hasOtherConversations.mockResolvedValue(false);

    expect(await resolve({}, dynamicContext("authjs"))).toBeNull();
  });

  it("stays out of background work", async () => {
    expect(await resolve({}, dynamicContext("scheduled-worker"))).toBeNull();
    expect(await resolve({}, dynamicContext("scheduled-result"))).toBeNull();
    expect(mocks.hasOtherConversations).not.toHaveBeenCalled();
  });
});

function dynamicContext(authenticator: string) {
  return {
    model: null,
    channel: { kind: "eve", metadata: {} },
    messages: [],
    session: {
      auth: {
        current: {
          attributes: { workspaceId: "personal:workspace" },
          authenticator,
          principalId: "user-1",
          principalType: "user",
        },
        initiator: null,
      },
      id: "session-new",
    },
  } satisfies DynamicResolveContext;
}

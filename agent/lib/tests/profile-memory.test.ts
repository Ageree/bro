import type { MemoryScopeContext, MemoryToolsContext } from "eve/memory";
import { describe, expect, it } from "vitest";
import personalInfoMemory from "@agent/memory/personal_info";
import { resolveProfileMemoryScope } from "@agent/lib/profile-memory";
import { parseLegacyDocument } from "@agent/lib/memory/profile";
import { accessScopeForUser } from "@shared/identity/access-scope";

const derivedWorkspaceId = accessScopeForUser("better-auth:user").workspaceId;

describe("profile memory", () => {
  it("preserves deleted-tail and empty legacy allocation watermarks", () => {
    expect(
      parseLegacyDocument(
        "<!-- eve-memory-file-v1 lastAllocatedIndex=40 -->\n2: Likes trains\n"
      )
    ).toEqual({
      entries: [{ index: 2, text: "Likes trains" }],
      lastAllocatedIndex: 40,
    });
    expect(
      parseLegacyDocument("<!-- eve-memory-file-v1 lastAllocatedIndex=12 -->\n")
    ).toEqual({ entries: [], lastAllocatedIndex: 12 });
  });

  it("shares the canonical workspace across verified authenticators", () => {
    const workspaceId = derivedWorkspaceId;
    expect(
      resolveProfileMemoryScope(
        memoryContext(userPrincipal("authjs", workspaceId))
      )
    ).toBe(workspaceId);
    expect(
      resolveProfileMemoryScope(
        memoryContext(userPrincipal("photon-imessage", workspaceId))
      )
    ).toBe(workspaceId);
  });

  it("disables memory without an authenticated workspace user", () => {
    expect(resolveProfileMemoryScope(memoryContext(null))).toBeNull();
    expect(
      resolveProfileMemoryScope(
        memoryContext({
          ...userPrincipal("runtime", derivedWorkspaceId),
          principalType: "runtime",
        })
      )
    ).toBeNull();
    expect(
      resolveProfileMemoryScope(memoryContext(userPrincipal("authjs")))
    ).toBeNull();
  });

  it("shares personal information with a worker acting for the user", () => {
    expect(
      personalInfoMemory.scope(
        memoryContext(
          {
            attributes: {},
            authenticator: "runtime",
            principalId: "worker",
            principalType: "runtime",
          },
          userPrincipal("authjs", derivedWorkspaceId)
        )
      )
    ).toBe(derivedWorkspaceId);
  });

  it("omits user memory from scheduled reporting turns", () => {
    const context = memoryContext(
      userPrincipal("scheduled-result", derivedWorkspaceId)
    );

    expect(resolveProfileMemoryScope(context)).toBeNull();
    expect(personalInfoMemory.scope(context)).toBeNull();
  });

  it("offers profile updates only during interactive turns", async () => {
    const interactiveTools = await personalInfoMemory.provider.tools(
      memoryToolsContext(userPrincipal("authjs", derivedWorkspaceId))
    );
    expect(Object.keys(interactiveTools ?? {})).toEqual(["update"]);

    const scheduledTools = await personalInfoMemory.provider.tools(
      memoryToolsContext(userPrincipal("scheduled-worker", derivedWorkspaceId))
    );
    expect(scheduledTools).toBeNull();
  });
});

function memoryToolsContext(
  current: MemoryToolsContext["session"]["auth"]["current"],
  initiator: MemoryToolsContext["session"]["auth"]["initiator"] = null
): MemoryToolsContext {
  return {
    model: null,
    channel: {},
    memory: {
      scope: {
        key: "personal-info-key",
        namespace: "openinstinct-personal-info-v1",
        value: derivedWorkspaceId,
      },
      slot: "personal_info",
    },
    messages: [],
    session: {
      auth: { current, initiator },
      id: "session",
    },
    turn: { id: "turn", input: [], sequence: 1 },
  };
}

function memoryContext(
  current: MemoryScopeContext["session"]["auth"]["current"],
  initiator: MemoryScopeContext["session"]["auth"]["initiator"] = null
): MemoryScopeContext {
  return {
    abortSignal: new AbortController().signal,
    channel: {},
    session: {
      auth: { current, initiator },
      id: "session",
    },
  };
}

function userPrincipal(
  authenticator: string,
  workspaceId?: string
): NonNullable<MemoryScopeContext["session"]["auth"]["current"]> {
  return {
    attributes: workspaceId === undefined ? {} : { workspaceId },
    authenticator,
    principalId: "better-auth:user",
    principalType: "user",
  };
}

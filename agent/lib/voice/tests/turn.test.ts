import type { ModelMessage } from "ai";
import { describe, expect, it, vi } from "vitest";

const workspaceId = "personal:voice";

async function load(fast: string) {
  vi.resetModules();
  vi.stubEnv("OPENAI_API_KEY", "sk-test-voice");
  vi.stubEnv("VOICE_WORKSPACES", "*");
  vi.stubEnv("VOICE_FAST_WORKSPACES", fast);
  return (await import("@agent/lib/voice/turn")).fastVoiceTurn;
}

/** A tool call's context in a turn: only its session and turn matter. */
function call(turnId: string) {
  return {
    session: {
      auth: { current: null, initiator: null },
      id: "session-1",
      turn: { id: turnId, sequence: 0 },
    },
  };
}

const said = (content: string): ModelMessage => ({ content, role: "user" });
const voiced = [
  said("привет"),
  { content: "Привет!", role: "assistant" },
  said("[голосом] Какая завтра погода?"),
] satisfies ModelMessage[];

describe("a turn from the voice", () => {
  it("is the fast voice's when the person's latest words came from /talk", async () => {
    const fastVoiceTurn = await load(workspaceId);
    expect(await fastVoiceTurn(voiced, workspaceId)).toBe(true);
    expect(
      await fastVoiceTurn([...voiced, said("а в субботу?")], workspaceId)
    ).toBe(false);
  });

  it("keeps the verdict of its first step through the turn", async () => {
    const fastVoiceTurn = await load(workspaceId);
    const turn = { sessionId: "session-1", turnId: "turn_3" };
    expect(await fastVoiceTurn(voiced, workspaceId, turn)).toBe(true);
    // A typed message mid-turn.
    expect(
      await fastVoiceTurn([...voiced, said("и в субботу")], workspaceId, turn)
    ).toBe(true);
  });

  it("is no different from a typed one outside the fast pilot", async () => {
    const fastVoiceTurn = await load("personal:someone-else");
    expect(await fastVoiceTurn(voiced, workspaceId)).toBe(false);
  });

  // A Google tool of a voice turn answers in words instead of the card.
  it("is known to a tool call of the turn its step found, and to no other", async () => {
    const fastVoiceTurn = await load(workspaceId);
    const { voiceTurnOfCall } = await import("@agent/lib/voice/turn");
    await fastVoiceTurn(voiced, workspaceId, {
      sessionId: "session-1",
      turnId: "turn_3",
    });

    expect(await voiceTurnOfCall(call("turn_3"), workspaceId)).toBe(true);
    expect(await voiceTurnOfCall(call("turn_4"), workspaceId)).toBe(false);
    // The tool's question sets nothing: the step still decides turn_4.
    expect(
      await fastVoiceTurn(voiced, workspaceId, {
        sessionId: "session-1",
        turnId: "turn_4",
      })
    ).toBe(true);
  });
});

import { describe, expect, it } from "vitest";
import { turnMemory } from "@agent/lib/turn-kind/step";

describe("the memory of a turn", () => {
  it("keeps a turn read between its steps over newer ones", () => {
    const memory = turnMemory<string>();
    const long = { sessionId: "s-long", stepIndex: 1, turnId: "turn_1" };
    memory.set(long, "first");
    for (let turn = 0; turn < 999; turn += 1) {
      memory.set(
        { sessionId: "s-other", turnId: `turn_${String(turn)}` },
        "other"
      );
    }
    expect(memory.get({ ...long, stepIndex: 2 })).toBe("first");
    memory.set({ sessionId: "s-other", turnId: "turn_999" }, "other");
    expect(memory.get({ ...long, stepIndex: 3 })).toBe("first");
    expect(memory.get({ sessionId: "s-other", turnId: "turn_0" })).toBe(
      undefined
    );
  });

  it("keeps nothing for a step without a turn id", () => {
    const memory = turnMemory<string>();
    memory.set({ sessionId: "s-1" }, "value");
    expect(memory.get({ sessionId: "s-1" })).toBe(undefined);
  });
});

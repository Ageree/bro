import type { ModelMessage } from "ai";
import { describe, expect, it } from "vitest";
import {
  firstContactMarker,
  firstContactTurn,
} from "@agent/lib/delivery/first-contact";

/** A user-role message as eve keeps it, with the kind it tags it with. */
function tagged(kind: string, content: string): ModelMessage {
  return Object.assign({ content, role: "user" as const }, { kind });
}

const question = tagged("user", "Как называется столица Франции?");
const introduction: ModelMessage = {
  content: "Привет! Я Бро.",
  role: "assistant",
};

describe("firstContactTurn", () => {
  it("holds for the turn that answers the person's very first message", () => {
    expect(
      firstContactTurn([
        tagged("memory.load", "Workstream memory"),
        tagged("context.instruction", firstContactMarker),
        question,
        introduction,
      ])
    ).toBe(true);
  });

  it("ends once the person writes again in the same conversation", () => {
    expect(
      firstContactTurn([
        tagged("context.instruction", firstContactMarker),
        question,
        introduction,
        tagged("user", "А какой там музей?"),
      ])
    ).toBe(false);
  });

  it("does not hold without the marker", () => {
    expect(firstContactTurn([question, introduction])).toBe(false);
  });

  it("tells the model the introduction is not the reply", () => {
    expect(firstContactMarker).toContain("Знакомство не заменяет ответ");
  });
});

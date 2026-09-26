import { type InputRequest, resolveTextToResponse } from "eve/client";
import { describe, expect, it } from "vitest";

/** The request eve parks for a tool call that needs the person's yes. */
const approval: InputRequest = {
  action: {
    callId: "call-1",
    input: { to: "anna@example.com" },
    kind: "tool-call",
    toolName: "gmail-send",
  },
  allowFreeform: false,
  display: "confirmation",
  kind: "tool-approval",
  options: [
    { id: "approve", label: "Approve" },
    { id: "cancel", label: "Cancel" },
  ],
  prompt: "Approve tool call: gmail-send",
  requestId: "approval-1",
};

describe("a typed answer to an approval card", () => {
  it.each([
    "да",
    "Да!",
    "ДА",
    "отправляй",
    "давай",
    "ну давай, отправляй",
    "ок",
    "yes",
    "Yes, go ahead",
    "go ahead",
    "sure",
    "👍",
  ])("«%s» approves", (text) => {
    expect(resolveTextToResponse(text, approval)).toEqual({
      optionId: "approve",
      requestId: "approval-1",
    });
  });

  it.each([
    "нет",
    "Нет.",
    "не надо",
    "не отправляй",
    "не сейчас",
    "отмена",
    "no",
    "No, don't send it",
    "do not send",
    "not now",
    "cancel",
  ])("«%s» declines", (text) => {
    expect(resolveTextToResponse(text, approval)).toEqual({
      optionId: "cancel",
      requestId: "approval-1",
    });
  });

  it.each([
    "а сколько стоит?",
    "да?",
    "да, но поменяй время",
    "да нет",
    "не знаю",
    "спасибо",
    "what does it cost?",
    "yes but change the subject",
  ])("«%s» does not decide, so it reaches Bro as a message", (text) => {
    expect(resolveTextToResponse(text, approval)).toBeUndefined();
  });

  it("still takes the option id, the label and the number", () => {
    expect(resolveTextToResponse("approve", approval)?.optionId).toBe(
      "approve"
    );
    expect(resolveTextToResponse("Cancel", approval)?.optionId).toBe("cancel");
    expect(resolveTextToResponse("1", approval)?.optionId).toBe("approve");
    expect(resolveTextToResponse("2", approval)?.optionId).toBe("cancel");
  });

  it("leaves a question Bro asked to its own options and free text", () => {
    const question: InputRequest = {
      ...approval,
      allowFreeform: true,
      display: "select",
      kind: "question",
      options: [
        { id: "morning", label: "Утром" },
        { id: "evening", label: "Вечером" },
      ],
      prompt: "Когда удобнее?",
    };

    expect(resolveTextToResponse("да", question)).toEqual({
      requestId: "approval-1",
      text: "да",
    });
  });
});

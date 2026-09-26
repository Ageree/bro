import type { InputRequest } from "eve/client";
import { describe, expect, it } from "vitest";
import {
  decideInputRequest,
  ownDataTools,
  responseFromText,
} from "../../bench/approvals.ts";

function approvalCard(
  toolName: string,
  input: InputRequest["action"]["input"] = {}
): InputRequest {
  return {
    action: { callId: "call_1", input, kind: "tool-call", toolName },
    allowFreeform: false,
    display: "confirmation",
    kind: "tool-approval",
    options: [
      { id: "approve", label: "Approve" },
      { id: "cancel", label: "Cancel" },
    ],
    prompt: `Approve tool call: ${toolName}`,
    requestId: "req_1",
  };
}

describe("decideInputRequest", () => {
  it.each([
    "browser_task",
    "gmail-send",
    "slack-send-message",
    "spend_limit",
    "google_connect",
  ])(
    "cancels %s: payments, bookings and messages are never approved",
    (tool) => {
      const decision = decideInputRequest(
        approvalCard(tool, { allowPayment: true }),
        ownDataTools
      );
      expect(decision).toMatchObject({
        kind: "respond",
        response: { optionId: "cancel", requestId: "req_1" },
      });
    }
  );

  it("approves an event in the tester's own calendar", () => {
    const decision = decideInputRequest(
      approvalCard("calendar-create-event", {
        attendees: [],
        summary: "Лекция",
      }),
      ownDataTools
    );
    expect(decision).toMatchObject({ response: { optionId: "approve" } });
  });

  it("cancels an event update: it can mail the event's existing guests", () => {
    const decision = decideInputRequest(
      approvalCard("calendar-update-event", {
        eventId: "evt_1",
        start: "2026-09-25T15:00:00+05:00",
      }),
      ownDataTools
    );
    expect(decision).toMatchObject({ response: { optionId: "cancel" } });
  });

  it("cancels an event that would invite someone", () => {
    const decision = decideInputRequest(
      approvalCard("calendar-create-event", {
        attendees: ["petya@example.com"],
        summary: "Созвон",
      }),
      ownDataTools
    );
    expect(decision).toMatchObject({ response: { optionId: "cancel" } });
  });

  it("approves a tool the run explicitly allowed", () => {
    expect(
      decideInputRequest(approvalCard("gmail-send"), ["gmail-send"])
    ).toMatchObject({ response: { optionId: "approve" } });
  });

  it("continues a long turn past the session limit", () => {
    const decision = decideInputRequest(
      { ...approvalCard("send_message"), kind: "session-limit" },
      ownDataTools
    );
    expect(decision).toMatchObject({ response: { optionId: "continue" } });
  });

  it("leaves questions to the tester", () => {
    const decision = decideInputRequest(
      { ...approvalCard("ask_question"), kind: "question" },
      ownDataTools
    );
    expect(decision.kind).toBe("ask-tester");
  });

  it("leaves a held tool's card to the owner instead of cancelling it", () => {
    const decision = decideInputRequest(
      approvalCard("browser_task", { allowPayment: true }),
      ownDataTools,
      ["browser_task"]
    );
    expect(decision).toMatchObject({ kind: "ask-tester" });
  });

  it("cancels the same tool as before when it is not held", () => {
    const decision = decideInputRequest(
      approvalCard("browser_task", { allowPayment: true }),
      ownDataTools,
      []
    );
    expect(decision).toMatchObject({
      kind: "respond",
      response: { optionId: "cancel", requestId: "req_1" },
    });
  });

  it("still approves an own-data tool that is not held", () => {
    const decision = decideInputRequest(
      approvalCard("calendar-create-event", {
        attendees: [],
        summary: "Лекция",
      }),
      ownDataTools,
      ["browser_task"]
    );
    expect(decision).toMatchObject({
      kind: "respond",
      response: { optionId: "approve" },
    });
  });
});

describe("responseFromText", () => {
  it("picks an option by id or label", () => {
    expect(responseFromText(approvalCard("gmail-send"), "Cancel")).toEqual({
      optionId: "cancel",
      requestId: "req_1",
    });
  });

  it("answers a free-form question with the text", () => {
    const question = {
      ...approvalCard("ask_question"),
      allowFreeform: true,
      kind: "question" as const,
      options: undefined,
    };
    expect(responseFromText(question, "с Ленинградского")).toEqual({
      requestId: "req_1",
      text: "с Ленинградского",
    });
  });

  it("refuses text an approval card cannot take", () => {
    expect(() => responseFromText(approvalCard("gmail-send"), "да")).toThrow(
      /approve/u
    );
  });
});

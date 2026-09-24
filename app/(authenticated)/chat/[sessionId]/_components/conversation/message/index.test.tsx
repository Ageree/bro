import type { EveMessage } from "eve/react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { AgentMessage } from ".";

describe("agent messages", () => {
  it("renders ordinary assistant text without a delivery tool result", () => {
    const message = {
      id: "assistant-message",
      metadata: { status: "complete" },
      parts: [
        {
          state: "done",
          text: "Hello from ordinary assistant output.",
          type: "text",
        },
      ],
      role: "assistant",
    } satisfies EveMessage;

    const markup = renderToStaticMarkup(
      <AgentMessage
        canRespond
        isStreaming={false}
        message={message}
        onInputResponses={() => undefined}
      />
    );

    expect(markup).toContain("Hello from ordinary assistant output.");
  });

  it("renders only channel-delivered content in the iMessage view", () => {
    const message = {
      id: "turn-1:assistant",
      metadata: { status: "complete", turnId: "turn-1" },
      parts: [
        {
          state: "done",
          stepIndex: 1,
          text: "I’ll check that now.",
          type: "text",
        },
        {
          state: "done",
          stepIndex: 0,
          text: "Private reasoning",
          type: "reasoning",
        },
        {
          input: { query: "example" },
          output: { result: "internal" },
          state: "output-available",
          stepIndex: 0,
          toolCallId: "call-1",
          toolName: "web_search",
          type: "dynamic-tool",
        },
        {
          state: "done",
          stepIndex: 1,
          text: "Here’s what I found.",
          type: "text",
        },
      ],
      role: "assistant",
    } satisfies EveMessage;

    const markup = renderToStaticMarkup(
      <AgentMessage
        canRespond
        isStreaming={false}
        message={message}
        onInputResponses={() => undefined}
        sentMessageParts={[
          {
            state: "done",
            stepIndex: 1,
            text: "Here’s what I found.",
            type: "text",
          },
        ]}
        userVisibleOnly
      />
    );

    expect(markup).toContain("Here’s what I found.");
    expect(markup).not.toContain("I’ll check that now.");
    expect(markup).not.toContain("Private reasoning");
    expect(markup).not.toContain("web_search");
  });

  it("shows a waiting card in the iMessage projection without the tool behind it", () => {
    const message = {
      id: "turn-2:assistant",
      metadata: { status: "streaming", turnId: "turn-2" },
      parts: [
        {
          approval: { id: "approval-1" },
          input: { amount: 50, recipient: "Hidden recipient" },
          state: "approval-requested",
          stepIndex: 0,
          toolCallId: "call-2",
          toolMetadata: {
            eve: {
              inputRequest: {
                kind: "tool-approval",
                options: [
                  { id: "approve", label: "Approve", style: "primary" },
                  { id: "cancel", label: "Cancel", style: "danger" },
                ],
                prompt: "Approve this action?",
                requestId: "approval-1",
              },
              kind: "tool-call",
              name: "send_payment",
            },
          },
          toolName: "send_payment",
          type: "dynamic-tool",
        },
      ],
      role: "assistant",
    } satisfies EveMessage;

    const markup = renderToStaticMarkup(
      <AgentMessage
        canRespond
        isStreaming={false}
        message={message}
        onInputResponses={() => undefined}
        userVisibleOnly
      />
    );

    // The card is the person's to answer, as in Telegram and iMessage; the
    // call behind it stays in the trace view.
    expect(markup).toContain("Approve this action?");
    expect(markup).toContain("Approve");
    expect(markup).toContain("Cancel");
    expect(markup).not.toContain("send_payment");
    expect(markup).not.toContain("Hidden recipient");
  });

  it("says what a card lets through instead of the tool's name", () => {
    const message = {
      id: "turn-3:assistant",
      metadata: { status: "streaming", turnId: "turn-3" },
      parts: [
        {
          approval: { id: "approval-2" },
          input: { action: "allow", kind: "table" },
          state: "approval-requested",
          stepIndex: 0,
          toolCallId: "call-3",
          toolMetadata: {
            eve: {
              inputRequest: {
                kind: "tool-approval",
                options: [
                  { id: "approve", label: "Approve", style: "primary" },
                  { id: "cancel", label: "Cancel", style: "danger" },
                ],
                prompt: "Approve tool call: standing_permission",
                requestId: "approval-2",
              },
              kind: "tool-call",
              name: "standing_permission",
            },
          },
          toolName: "standing_permission",
          type: "dynamic-tool",
        },
      ],
      role: "assistant",
    } satisfies EveMessage;

    const markup = renderToStaticMarkup(
      <AgentMessage
        canRespond
        isStreaming={false}
        message={message}
        onInputResponses={() => undefined}
        userVisibleOnly
      />
    );

    expect(markup).toContain(
      "Постоянное разрешение — такие поручения дальше без подтверждения:"
    );
    expect(markup).toContain(
      "брони столиков без спроса, на любых сайтах, только бесплатное"
    );
    expect(markup).toContain("Подтвердить");
    expect(markup).not.toContain("Approve tool call");
  });
});

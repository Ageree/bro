import type { MessageStreamEvent } from "eve/client";
import type { EveMessage } from "eve/react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import {
  backgroundNoticeMessage,
  backgroundTurnMarker,
} from "@shared/chat/background-turn";
import { ChatConversation } from ".";
import type { ChatAgent } from "../chat-agent";

describe("chat conversation", () => {
  it("shows send_message output instead of assistant stream text", () => {
    const agent = {
      data: {
        messages: [
          message("turn-1:user", "What happened?"),
          {
            id: "turn-1:assistant",
            metadata: { status: "complete", turnId: "turn-1" },
            parts: [
              {
                state: "done",
                stepIndex: 0,
                text: "Internal assistant narration",
                type: "text",
              },
              {
                state: "done",
                stepIndex: 1,
                text: "DELIVERY_COMPLETE",
                type: "text",
              },
            ],
            role: "assistant",
          },
        ],
      },
      error: undefined,
      events: [sendMessageResult("The visible iMessage response.")],
      respond: async () => undefined,
      status: "ready",
    } satisfies Pick<
      ChatAgent,
      "data" | "error" | "events" | "respond" | "status"
    >;

    const markup = renderToStaticMarkup(
      <ChatConversation agent={agent} traceView="imessage" />
    );

    expect(markup).toContain("What happened?");
    expect(markup).toContain("The visible iMessage response.");
    expect(markup).not.toContain("Internal assistant narration");
    expect(markup).not.toContain("DELIVERY_COMPLETE");
  });

  it("shows a proactive message without the prompt Bro wrote to itself", () => {
    const agent = {
      data: {
        messages: [
          message(
            "turn-1:user",
            `${backgroundTurnMarker}\n\nYour own background check of the person's mail and calendar found something.`
          ),
          {
            id: "turn-1:assistant",
            metadata: { status: "complete", turnId: "turn-1" },
            parts: [{ state: "done", text: "DELIVERY_COMPLETE", type: "text" }],
            role: "assistant",
          },
        ],
      },
      error: undefined,
      events: [sendMessageResult("Рейс UA 1532 завтра в 07:40.")],
      respond: async () => undefined,
      status: "ready",
    } satisfies Pick<
      ChatAgent,
      "data" | "error" | "events" | "respond" | "status"
    >;

    const markup = renderToStaticMarkup(
      <ChatConversation agent={agent} traceView="imessage" />
    );

    expect(markup).toContain("Рейс UA 1532 завтра в 07:40.");
    expect(markup).not.toContain("background check");
    expect(markup).not.toContain(backgroundTurnMarker);
  });

  it("shows a notice code wrote in Bro's name as Bro's message", () => {
    const notice =
      "Поручение «ozon.ru» закончено, но итог не дошёл. Спросите меня «что там с ozon.ru», и я расскажу.";
    const agent = {
      data: {
        messages: [
          message("turn-1:user", backgroundNoticeMessage(notice)),
          {
            id: "turn-1:assistant",
            metadata: { status: "complete", turnId: "turn-1" },
            parts: [
              { state: "done", text: "<eve-empty-delivery/>", type: "text" },
            ],
            role: "assistant",
          },
        ],
      },
      error: undefined,
      events: [],
      respond: async () => undefined,
      status: "ready",
    } satisfies Pick<
      ChatAgent,
      "data" | "error" | "events" | "respond" | "status"
    >;

    const markup = renderToStaticMarkup(
      <ChatConversation agent={agent} traceView="imessage" />
    );

    expect(markup).toContain(notice);
    expect(markup).toContain('flex-col gap-2 is-assistant"');
    expect(markup).not.toContain("is-user ml-auto");
    expect(markup).not.toContain(backgroundTurnMarker);
  });

  describe("while Bro has not answered yet", () => {
    const typing = "Bro печатает…";
    const thinking: EveMessage = {
      id: "turn-1:assistant",
      metadata: { status: "streaming", turnId: "turn-1" },
      parts: [{ type: "step-start" }],
      role: "assistant",
    };

    it("says so from the moment a message leaves", () => {
      const markup = drawn("submitted", [message("turn-1:user", "Привет")]);

      expect(markup).toContain(typing);
      expect(markup).toContain('aria-live="polite"');
    });

    it("keeps saying so while the turn runs and shows nothing of Bro's", () => {
      expect(
        drawn("streaming", [message("turn-1:user", "Привет"), thinking])
      ).toContain(typing);
      // A message sent into the running turn has no answer of its own yet.
      expect(
        drawn(
          "streaming",
          [
            message("turn-1:user", "Привет"),
            thinking,
            message("event-2:user", "и ещё"),
          ],
          [sendMessageResult("Привет!")]
        )
      ).toContain(typing);
    });

    it("stops once Bro's first message is drawn", () => {
      const markup = drawn(
        "streaming",
        [message("turn-1:user", "Привет"), thinking],
        [sendMessageResult("Привет! Чем помочь?")]
      );

      expect(markup).toContain("Привет! Чем помочь?");
      expect(markup).not.toContain(typing);
    });

    it("stops for a card the person has to answer", () => {
      const markup = drawn("streaming", [
        message("turn-1:user", "Закажи"),
        {
          ...thinking,
          parts: [
            {
              approval: { id: "approval-1" },
              input: {},
              state: "approval-requested",
              stepIndex: 0,
              toolCallId: "call-1",
              toolMetadata: {
                eve: {
                  inputRequest: {
                    kind: "tool-approval",
                    options: [{ id: "approve", label: "Approve" }],
                    prompt: "Approve tool call: yandex_purchase",
                    requestId: "approval-1",
                  },
                  kind: "tool-call",
                  name: "yandex_purchase",
                },
              },
              toolName: "yandex_purchase",
              type: "dynamic-tool",
            },
          ],
        },
      ]);

      expect(markup).not.toContain(typing);
    });

    it("is not shown when the turn is Bro's own", () => {
      expect(
        drawn("streaming", [
          message("turn-1:user", `${backgroundTurnMarker}\n\nCheck the mail.`),
          thinking,
        ])
      ).not.toContain(typing);
    });

    it("is not shown when nothing is running or in the trace view", () => {
      const person = message("turn-1:user", "Привет");

      expect(drawn("ready", [person])).not.toContain(typing);
      expect(drawn("error", [person])).not.toContain(typing);
      expect(drawn("submitted", [person], [], "trace")).not.toContain(typing);
    });
  });

  it("hides runtime errors from the iMessage transcript", () => {
    const agent = {
      data: { messages: [message("turn-1:user", "Try this")] },
      error: new Error("Internal runtime failure"),
      events: [],
      respond: async () => undefined,
      status: "error",
    } satisfies Pick<
      ChatAgent,
      "data" | "error" | "events" | "respond" | "status"
    >;

    const markup = renderToStaticMarkup(
      <ChatConversation agent={agent} traceView="imessage" />
    );

    expect(markup).toContain("Try this");
    expect(markup).not.toContain("Request failed");
    expect(markup).not.toContain("Internal runtime failure");
  });
});

function drawn(
  status: ChatAgent["status"],
  messages: EveMessage[],
  events: MessageStreamEvent[] = [],
  traceView: "imessage" | "trace" = "imessage"
) {
  return renderToStaticMarkup(
    <ChatConversation
      agent={{
        data: { messages },
        error: undefined,
        events,
        respond: async () => undefined,
        status,
      }}
      traceView={traceView}
    />
  );
}

function message(id: string, text: string): EveMessage {
  return {
    id,
    metadata: { status: "complete", turnId: id.split(":")[0] },
    parts: [{ state: "done", text, type: "text" }],
    role: "user",
  };
}

function sendMessageResult(text: string): MessageStreamEvent {
  return {
    data: {
      result: {
        callId: "call_send_message",
        kind: "tool-result",
        output: { kind: "message", text },
        toolName: "send_message",
      },
      sequence: 1,
      status: "completed",
      stepIndex: 1,
      turnId: "turn-1",
    },
    meta: { at: "2026-09-01T20:00:00.000Z", id: "send-result" },
    type: "action.result",
  };
}

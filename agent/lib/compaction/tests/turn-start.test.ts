import type { ModelMessage, UserModelMessage } from "ai";
import { describe, expect, it } from "vitest";
import { compactsAtTurnStart } from "@agent/lib/compaction/turn-start";
import { compactionWindow } from "@agent/lib/compaction/window";

function tagged(content: UserModelMessage["content"], kind: string) {
  return Object.assign({ content, role: "user" as const }, { kind });
}

const earlier: ModelMessage[] = [
  tagged("найди билеты в Казань", "user"),
  {
    content: [
      {
        input: { kind: "message", text: "Нашёл три рейса." },
        toolCallId: "call-1",
        toolName: "send_message",
        type: "tool-call",
      },
    ],
    role: "assistant",
  },
  {
    content: [
      {
        output: { type: "json", value: { status: "sent" } },
        toolCallId: "call-1",
        toolName: "send_message",
        type: "tool-result",
      },
    ],
    role: "tool",
  },
  { content: "Готово.", role: "assistant" },
];

const opener = tagged("а на поезд?", "user");

describe("whether a step may compact the conversation", () => {
  it("lets the first step of a turn a person's text opened compact", () => {
    expect(compactsAtTurnStart([...earlier, opener])).toBe(true);
    // An untagged user message is a person's, as eve's own readers take it.
    expect(compactsAtTurnStart([{ content: "привет", role: "user" }])).toBe(
      true
    );
    // A browser run's report is a plain-text opener of its own.
    expect(
      compactsAtTurnStart([
        ...earlier,
        tagged("Browser run 1 finished.", "user"),
      ])
    ).toBe(true);
  });

  it("looks past eve's memory records after the opener", () => {
    expect(
      compactsAtTurnStart([
        ...earlier,
        opener,
        tagged('<bro-skill name="travel">…</bro-skill>', "memory.load"),
        tagged("Workstream memory: …", "memory.load"),
      ])
    ).toBe(true);
  });

  it("keeps a photo or a file opener whole: the guard would bring back older text", () => {
    expect(
      compactsAtTurnStart([
        ...earlier,
        tagged(
          [
            { text: "что на фото?", type: "text" },
            {
              data: "eve-sandbox:/photo.jpg",
              mediaType: "image/jpeg",
              type: "file",
            },
          ],
          "user"
        ),
      ])
    ).toBe(false);
  });

  it("never compacts the task agent's report, a retry or a context message last", () => {
    for (const kind of [
      "execution.background_task",
      "execution.retry",
      "execution.continuation",
      "context.state",
      "context.instruction",
      "context.compaction",
    ]) {
      expect(compactsAtTurnStart([...earlier, opener, tagged("x", kind)])).toBe(
        false
      );
    }
  });

  it("never compacts after a step or an approval's answer", () => {
    const step: ModelMessage = {
      content: [
        {
          input: { query: "поезд Москва Казань" },
          toolCallId: "call-2",
          toolName: "web_search",
          type: "tool-call",
        },
      ],
      role: "assistant",
    };
    const result: ModelMessage = {
      content: [
        {
          output: { type: "text", value: "…" },
          toolCallId: "call-2",
          toolName: "web_search",
          type: "tool-result",
        },
      ],
      role: "tool",
    };
    const approval: ModelMessage = {
      content: [
        {
          approvalId: "approval-1",
          approved: true,
          type: "tool-approval-response",
        },
      ],
      role: "tool",
    };
    expect(compactsAtTurnStart([...earlier, opener, step])).toBe(false);
    expect(compactsAtTurnStart([...earlier, opener, step, result])).toBe(false);
    expect(compactsAtTurnStart([...earlier, opener, step, approval])).toBe(
      false
    );
    expect(compactsAtTurnStart(earlier)).toBe(false);
    expect(compactsAtTurnStart([])).toBe(false);
  });
});

describe("the window a compacting step reports", () => {
  it("is the one whose share is the input to compact at, within the model's own", () => {
    expect(compactionWindow(1_048_576, 150_000)).toBe(214_286);
    expect(Math.floor(214_286 * 0.7)).toBe(150_000);
    expect(compactionWindow(200_000, 150_000)).toBe(200_000);
  });
});

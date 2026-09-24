import type { ModelMessage, ToolResultPart } from "ai";
import { describe, expect, it } from "vitest";
import { googleRateLimitMessage } from "@agent/lib/google-workspace/client";
import {
  googleReadKey,
  readRefusalNotice,
  readRefusalReason,
  readsMustEnd,
  turnReadLimit,
  turnReads,
} from "@agent/lib/google-workspace/turn-reads";

const inbox = { query: "in:inbox is:unread" };

describe("googleReadKey", () => {
  it("treats a spelled-out default as the same search", () => {
    const defaulted = turnReads([person("почта"), ...search("call-1")]);
    const spelledOut = turnReads([
      person("почта"),
      ...search("call-1", undefined, inbox.query, 10),
    ]);

    expect(spelledOut.done).toEqual(defaulted.done);
    expect(defaulted.done).toEqual([searchKey(inbox.query)]);
    expect(searchKey(inbox.query, 5)).not.toBe(searchKey(inbox.query));
  });
});

describe("the per-turn Gmail read guard", () => {
  it("answers the same search twice in a turn from what the turn has", () => {
    const reads = turnReads([person("разбери почту"), ...search("call-1")]);
    const key = searchKey(inbox.query);

    expect(readRefusalReason(key, reads)).toBe("duplicate");
    expect(readRefusalReason(searchKey("from:bank"), reads)).toBeUndefined();
    expect(readRefusalNotice("duplicate")).toContain("its result is above");
  });

  it("lets a read that failed for another reason run again", () => {
    const reads = turnReads([
      person("разбери почту"),
      ...search("call-1", { type: "error-text", value: "socket hang up" }),
    ]);

    expect(readRefusalReason(searchKey(inbox.query), reads)).toBeUndefined();
  });

  it("stops every read once Google refused for quota", () => {
    const reads = turnReads([
      person("разбери почту"),
      ...search("call-1", {
        type: "error-text",
        value: googleRateLimitMessage,
      }),
    ]);

    expect(readRefusalReason(searchKey("from:bank"), reads)).toBe(
      "rate_limited"
    );
    expect(readRefusalNotice("rate_limited")).toContain(
      "Google временно ограничил запросы"
    );
  });

  it("caps the reads one turn makes", () => {
    const history = [
      person("разбери почту"),
      ...Array.from({ length: turnReadLimit }, (_, index) =>
        search(`call-${String(index)}`, undefined, `query ${String(index)}`)
      ).flat(),
    ];

    expect(readRefusalReason(searchKey("one more"), turnReads(history))).toBe(
      "limit"
    );
  });

  it("starts counting again when the person writes", () => {
    const reads = turnReads([
      person("разбери почту"),
      ...search("call-1"),
      person("а теперь ещё раз"),
    ]);

    expect(readRefusalReason(searchKey(inbox.query), reads)).toBeUndefined();
  });

  it("ends a turn that keeps asking for refused reads", () => {
    const refused = (id: string) =>
      search(id, { type: "text", value: readRefusalNotice("duplicate") });
    const history = [person("разбери почту"), ...search("call-0")];

    expect(readsMustEnd([...history, ...refused("call-1")])).toBe(false);
    expect(
      readsMustEnd([
        ...history,
        ...refused("call-1"),
        ...refused("call-2"),
        ...refused("call-3"),
      ])
    ).toBe(true);
  });
});

function person(text: string): ModelMessage {
  // eve adds `kind` to every user-role message it keeps in history.
  return Object.assign(
    { content: text, role: "user" as const },
    { kind: "user" }
  );
}

function searchKey(query: string, maxResults = 10) {
  return googleReadKey({
    input: { maxResults, query },
    toolName: "gmail-search",
  });
}

function search(
  toolCallId: string,
  output: ToolResultPart["output"] = { type: "json", value: { messages: [] } },
  query = inbox.query,
  maxResults?: number
): ModelMessage[] {
  return [
    {
      content: [
        {
          input: maxResults === undefined ? { query } : { maxResults, query },
          toolCallId,
          toolName: "gmail-search",
          type: "tool-call",
        },
      ],
      role: "assistant",
    },
    {
      content: [
        { output, toolCallId, toolName: "gmail-search", type: "tool-result" },
      ],
      role: "tool",
    },
  ];
}

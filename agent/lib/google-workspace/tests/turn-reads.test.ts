import type { ModelMessage, ToolResultPart } from "ai";
import { describe, expect, it } from "vitest";
import { googleRateLimitMessage } from "@agent/lib/google-workspace/client";
import {
  googleReadKey,
  readRefusalNotice,
  readRefusalReason,
  readsMustEnd,
  turnGmailUpdates,
  turnReadLimits,
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

  it("tells Drive searches for another file type apart", () => {
    expect(driveSearchKey("pdf")).not.toBe(driveSearchKey("image"));
    expect(driveSearchKey("pdf")).not.toBe(driveSearchKey(undefined, "pdf"));
    expect(driveSearchKey("pdf", "отчёт")).toBe(driveSearchKey("pdf", "отчёт"));
  });
});

describe("the per-turn Google read guard", () => {
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
      ...Array.from({ length: turnReadLimits.interactive }, (_, index) =>
        search(`call-${String(index)}`, undefined, `query ${String(index)}`)
      ).flat(),
    ];

    expect(readRefusalReason(searchKey("one more"), turnReads(history))).toBe(
      "limit"
    );
  });

  it("gives a background worker more reads than a reply", () => {
    const history = [
      person("разбери почту"),
      ...Array.from({ length: turnReadLimits.interactive }, (_, index) =>
        search(`call-${String(index)}`, undefined, `query ${String(index)}`)
      ).flat(),
    ];

    expect(
      readRefusalReason(
        searchKey("one more"),
        turnReads(history, turnReadLimits.background)
      )
    ).toBeUndefined();
  });

  it("reads again after the turn changed the mailbox", () => {
    const reads = turnReads([
      person("архивируй рассылки и покажи, что осталось"),
      ...search("call-1"),
      ...gmailUpdate("call-2", ["a", "b"]),
    ]);

    expect(readRefusalReason(searchKey(inbox.query), reads)).toBeUndefined();
  });

  it("reads again after the turn moved or deleted a calendar event", () => {
    for (const toolName of ["calendar-update-event", "calendar-delete-event"]) {
      const reads = turnReads([
        person("перенеси встречу и проверь почту"),
        ...search("call-1"),
        ...calendarWrite("call-2", toolName),
      ]);

      expect(readRefusalReason(searchKey(inbox.query), reads)).toBeUndefined();
    }
  });

  it("keeps the result when the mailbox change was refused", () => {
    const reads = turnReads([
      person("архивируй рассылки"),
      ...search("call-1"),
      ...gmailUpdate("call-2", ["a"], {
        reason: "denied",
        type: "execution-denied",
      }),
    ]);

    expect(readRefusalReason(searchKey(inbox.query), reads)).toBe("duplicate");
  });

  it("starts counting again when the person writes", () => {
    const reads = turnReads([
      person("разбери почту"),
      ...search("call-1"),
      person("а теперь ещё раз"),
    ]);

    expect(readRefusalReason(searchKey(inbox.query), reads)).toBeUndefined();
  });

  it("counts Drive reads against the same turn", () => {
    const history = [
      person("найди паспорт на Диске"),
      ...driveRead("call-1", "file-1"),
      ...Array.from({ length: turnReadLimits.interactive - 1 }, (_, index) =>
        search(`call-${String(index + 2)}`, undefined, `query ${String(index)}`)
      ).flat(),
    ];
    const reads = turnReads(history);

    expect(readRefusalReason(driveReadKey("file-1"), reads)).toBe("duplicate");
    expect(readRefusalReason(driveReadKey("file-2"), reads)).toBe("limit");
  });

  it("stops Drive reads once Google refused for quota", () => {
    const reads = turnReads([
      person("найди паспорт на Диске"),
      ...driveRead("call-1", "file-1", {
        type: "error-text",
        value: googleRateLimitMessage,
      }),
    ]);

    expect(readRefusalReason(searchKey(inbox.query), reads)).toBe(
      "rate_limited"
    );
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

describe("turnGmailUpdates", () => {
  it("counts every message the turn changed across calls", () => {
    expect(
      turnGmailUpdates([
        person("разбери почту"),
        ...gmailUpdate("call-1", ["a", "b", "c"]),
        ...gmailUpdate("call-2", ["c", "d"]),
        ...gmailUpdate("call-3", ["e"], { type: "error-text", value: "boom" }),
      ])
    ).toBe(4);
  });

  it("starts from zero on the person's next message", () => {
    expect(
      turnGmailUpdates([
        person("разбери почту"),
        ...gmailUpdate("call-1", ["a", "b", "c"]),
        person("теперь ещё"),
      ])
    ).toBe(0);
  });
});

function gmailUpdate(
  toolCallId: string,
  messageIds: string[],
  output: ToolResultPart["output"] = {
    type: "json",
    value: { update: "archive", updatedCount: messageIds.length },
  }
): ModelMessage[] {
  return [
    {
      content: [
        {
          input: { messageIds, update: "archive" },
          toolCallId,
          toolName: "gmail-update",
          type: "tool-call",
        },
      ],
      role: "assistant",
    },
    {
      content: [
        { output, toolCallId, toolName: "gmail-update", type: "tool-result" },
      ],
      role: "tool",
    },
  ];
}

function driveSearchKey(kind?: "pdf" | "image", query?: string) {
  return googleReadKey({
    input: { kind, maxResults: 10, query },
    toolName: "drive-search",
  });
}

function driveReadKey(fileId: string) {
  return googleReadKey({ input: { fileId }, toolName: "drive-read" });
}

function driveRead(
  toolCallId: string,
  fileId: string,
  output: ToolResultPart["output"] = {
    type: "json",
    value: { kind: "text", text: "Passport" },
  }
): ModelMessage[] {
  return [
    {
      content: [
        {
          input: { fileId },
          toolCallId,
          toolName: "drive-read",
          type: "tool-call",
        },
      ],
      role: "assistant",
    },
    {
      content: [
        { output, toolCallId, toolName: "drive-read", type: "tool-result" },
      ],
      role: "tool",
    },
  ];
}

function calendarWrite(toolCallId: string, toolName: string): ModelMessage[] {
  return [
    {
      content: [
        {
          input: { eventId: "event-1" },
          toolCallId,
          toolName,
          type: "tool-call",
        },
      ],
      role: "assistant",
    },
    {
      content: [
        {
          output: { type: "json", value: { eventId: "event-1" } },
          toolCallId,
          toolName,
          type: "tool-result",
        },
      ],
      role: "tool",
    },
  ];
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

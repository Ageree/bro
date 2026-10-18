import { defaultMessageReducer, type MessageStreamEvent } from "eve/client";
import { describe, expect, it } from "vitest";
import { messageDataOf } from "./message-data";

describe("message data", () => {
  it("folds a streamed event on from the history it extends", () => {
    const history = [...turn(1), ...turn(2)];
    const before = messageDataOf(history);
    const streamed = [
      ...history,
      received("turn_3", "ещё"),
      stamped({
        data: {
          messageDelta: "Ответ",
          sequence: 1,
          stepIndex: 0,
          turnId: "turn_3",
        },
        type: "message.appended",
      }),
    ];

    const after = messageDataOf(streamed);

    expect(after).toEqual(foldedAnew(streamed));
    // The rows of the earlier turns keep their messages and are not redrawn.
    expect(after.messages.slice(0, 4)).toEqual(before.messages);
    for (const [index, message] of before.messages.entries()) {
      expect(after.messages[index]).toBe(message);
    }
  });

  it("folds anew when older history is read in front", () => {
    const latest = turn(2);
    messageDataOf(latest);
    const withOlder = [...turn(1), ...latest];

    expect(messageDataOf(withOlder)).toEqual(foldedAnew(withOlder));
  });
});

// eve stamps `meta` on each event as it is written; a test event is written here.
type Unstamped<Event = MessageStreamEvent> = Event extends MessageStreamEvent
  ? Omit<Event, "meta">
  : never;

let id = 0;

function stamped(event: Unstamped): MessageStreamEvent {
  id += 1;
  return {
    ...event,
    meta: { at: "2026-10-01T10:00:00.000Z", id: `event-${String(id)}` },
  };
}

function received(turnId: string, message: string) {
  return stamped({
    data: { message, sequence: 0, turnId },
    type: "message.received",
  });
}

function turn(index: number) {
  const turnId = `turn_${String(index)}`;
  return [
    received(turnId, "Привет"),
    stamped({
      data: {
        finishReason: "stop",
        message: `Ответ ${String(index)}`,
        sequence: 1,
        stepIndex: 0,
        turnId,
      },
      type: "message.completed",
    }),
    stamped({ data: { sequence: 2, turnId }, type: "turn.completed" }),
  ];
}

function foldedAnew(events: readonly MessageStreamEvent[]) {
  const reducer = defaultMessageReducer();
  return events.reduce(
    (data, next) => reducer.reduce(data, next),
    reducer.initial()
  );
}

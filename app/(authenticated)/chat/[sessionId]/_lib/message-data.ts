import { defaultMessageReducer, type MessageStreamEvent } from "eve/client";
import type { EveMessageData } from "eve/react";

const messageReducer = defaultMessageReducer();

/**
 * The messages up to a history's last event, by that event. A streamed event
 * extends the history it follows, so the data is folded on from there rather
 * than from the first event: eve's reducer is pure and keeps every message
 * the new event does not touch, and a row of an untouched message is not
 * drawn again.
 */
const foldedThrough = new WeakMap<
  MessageStreamEvent,
  {
    readonly data: EveMessageData;
    readonly first: MessageStreamEvent;
    readonly length: number;
  }
>();

export function messageDataOf(events: readonly MessageStreamEvent[]) {
  let data = messageReducer.initial();
  let start = 0;
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    const folded = event && foldedThrough.get(event);
    // Older history read in front of it changes the first event: fold anew.
    if (folded?.length === index + 1 && folded.first === events[0]) {
      ({ data } = folded);
      start = index + 1;
      break;
    }
  }
  for (const event of events.slice(start)) {
    data = messageReducer.reduce(data, event);
  }
  const [first] = events;
  const last = events.at(-1);
  if (first && last) {
    foldedThrough.set(last, { data, first, length: events.length });
  }
  return data;
}

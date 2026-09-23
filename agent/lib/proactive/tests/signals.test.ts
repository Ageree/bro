import { describe, expect, it } from "vitest";
import {
  calendarSignals,
  gmailProbeQuery,
  gmailSignals,
  mailSearchStart,
  proactiveRunPrompt,
  selectRunSignals,
} from "@agent/lib/proactive/signals";

const now = new Date("2026-09-23T12:00:00.000Z");

describe("proactive signals", () => {
  it("overlaps the mail watermark but never looks back more than a day", () => {
    expect(mailSearchStart(new Date("2026-09-23T11:45:00.000Z"), now)).toEqual(
      new Date("2026-09-23T11:35:00.000Z")
    );
    expect(mailSearchStart(new Date("2026-09-10T00:00:00.000Z"), now)).toEqual(
      new Date("2026-09-22T12:00:00.000Z")
    );
  });

  it("searches only new inbox mail that is not promotional or the person's own", () => {
    expect(gmailProbeQuery(new Date("2026-09-23T11:35:00.000Z"))).toBe(
      "in:inbox after:1790163300 -category:promotions -category:social -from:me"
    );
  });

  it("keys mail by message id and keeps its thread for the worker", () => {
    expect(
      gmailSignals([
        { id: "m1", threadId: "t1" },
        { id: null, threadId: "t2" },
        { id: "m3" },
      ])
    ).toEqual([
      { dedupeKey: "m1", itemId: "m1", source: "gmail", threadId: "t1" },
      { dedupeKey: "m3", itemId: "m3", source: "gmail", threadId: "m3" },
    ]);
  });

  it("keys events by id and start, and drops cancelled or started ones", () => {
    expect(
      calendarSignals(
        [
          {
            id: "flight",
            start: { dateTime: "2026-09-24T07:40:00+03:00" },
            status: "confirmed",
          },
          {
            id: "cancelled",
            start: { dateTime: "2026-09-24T09:00:00Z" },
            status: "cancelled",
          },
          { id: "ongoing", start: { dateTime: "2026-09-23T11:00:00Z" } },
          { id: "holiday", start: { date: "2026-09-24" } },
          { id: null, start: { dateTime: "2026-09-24T10:00:00Z" } },
        ],
        now
      )
    ).toEqual([
      {
        dedupeKey: "flight@2026-09-24T07:40:00+03:00",
        itemId: "flight",
        source: "calendar",
        threadId: null,
      },
      {
        dedupeKey: "holiday@2026-09-24",
        itemId: "holiday",
        source: "calendar",
        threadId: null,
      },
    ]);
  });

  it("treats a moved event as a new signal", () => {
    const [before] = calendarSignals(
      [{ id: "flight", start: { dateTime: "2026-09-24T07:40:00Z" } }],
      now
    );
    const [after] = calendarSignals(
      [{ id: "flight", start: { dateTime: "2026-09-24T09:10:00Z" } }],
      now
    );
    expect(before?.dedupeKey).not.toBe(after?.dedupeKey);
  });

  it("puts events first and caps one run at twelve items", () => {
    const mail = gmailSignals(
      Array.from({ length: 20 }, (_, index) => ({ id: `m${String(index)}` }))
    );
    const events = calendarSignals(
      [{ id: "flight", start: { dateTime: "2026-09-24T07:40:00Z" } }],
      now
    );
    const selected = selectRunSignals([...mail, ...events]);
    expect(selected).toHaveLength(12);
    expect(selected[0]?.itemId).toBe("flight");
    expect(selected[1]?.itemId).toBe("m0");
  });

  it("names only the new threads and events and the calendar window", () => {
    const prompt = proactiveRunPrompt({
      scheduledFor: now,
      signals: [
        { itemId: "m1", source: "gmail", threadId: "t1" },
        { itemId: "m2", source: "gmail", threadId: "t1" },
        { itemId: "flight", source: "calendar", threadId: null },
      ],
    });
    expect(prompt).toContain("gmail-read-thread): t1\n");
    expect(prompt).toContain(
      "timeMin 2026-09-23T12:00:00.000Z and timeMax 2026-09-24T14:00:00.000Z"
    );
    expect(prompt).toContain("these ids): flight");
    expect(proactiveRunPrompt({ scheduledFor: now, signals: [] })).toContain(
      "No new mail."
    );
  });
});

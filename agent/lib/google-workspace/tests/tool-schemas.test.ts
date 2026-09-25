import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  calendarEventDeleteSchema,
  calendarEventSchema,
  calendarEventUpdateSchema,
} from "@agent/lib/google-workspace/calendar";
import { gmailComposeSchema } from "@agent/lib/google-workspace/gmail";
import { connectApp } from "@agent/tools/connect_app";
import { driveRead, driveSearch } from "@agent/tools/drive";
import { notionAddTask } from "@agent/tools/notion";
import { slackSendMessage } from "@agent/tools/slack";

// OpenAI's strict tool schemas reject any `pattern` with regex lookaround, and
// one such pattern fails every turn on those models.
const lookaround = /\(\?<?[=!]/u;

describe("Google Workspace tool input schemas", () => {
  it.each([
    ["gmail-send", gmailComposeSchema],
    ["calendar-create-event", calendarEventSchema],
    ["calendar-update-event", calendarEventUpdateSchema],
    ["calendar-delete-event", calendarEventDeleteSchema],
    ["connect_app", connectApp.inputSchema],
    ["drive-read", driveRead.inputSchema],
    ["drive-search", driveSearch.inputSchema],
    ["notion-add-task", notionAddTask.inputSchema],
    ["slack-send-message", slackSendMessage.inputSchema],
  ])("%s has no regex lookaround", (_name, schema) => {
    expect(
      JSON.stringify(z.toJSONSchema(z.instanceof(z.ZodType).parse(schema)))
    ).not.toMatch(lookaround);
  });

  it("still validates recipient addresses", () => {
    const base = { body: "hi", subject: "s" };
    expect(
      gmailComposeSchema.safeParse({ ...base, to: ["a.b+c@ranepa.ru"] }).success
    ).toBe(true);
    expect(
      gmailComposeSchema.safeParse({ ...base, to: ["bad@"] }).success
    ).toBe(false);
  });

  it("moves an event only with both ends and never changes nothing", () => {
    const event = { eventId: "event-1", eventTitle: "Созвон" };
    const start = "2026-09-25T10:00:00+03:00";
    const end = "2026-09-25T11:00:00+03:00";
    expect(
      calendarEventUpdateSchema.safeParse({ ...event, end, start }).success
    ).toBe(true);
    expect(
      calendarEventUpdateSchema.safeParse({ ...event, summary: "Созвон" })
        .success
    ).toBe(true);
    expect(
      calendarEventUpdateSchema.safeParse({ ...event, start }).success
    ).toBe(false);
    expect(calendarEventUpdateSchema.safeParse(event).success).toBe(false);
    // The card names the event by its title, so a change always carries it.
    expect(
      calendarEventUpdateSchema.safeParse({ eventId: "event-1", end, start })
        .success
    ).toBe(false);
  });
});

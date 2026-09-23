import { describe, expect, it } from "vitest";
import { z } from "zod";
import { calendarEventSchema } from "@agent/lib/google-workspace/calendar";
import { gmailSendSchema } from "@agent/lib/google-workspace/gmail";
import { connectApp } from "@agent/tools/connect_app";
import { driveRead, driveSearch } from "@agent/tools/drive";
import { notionAddTask } from "@agent/tools/notion";
import { slackSendMessage } from "@agent/tools/slack";

// OpenAI's strict tool schemas reject any `pattern` with regex lookaround, and
// one such pattern fails every turn on those models.
const lookaround = /\(\?<?[=!]/u;

describe("Google Workspace tool input schemas", () => {
  it.each([
    ["gmail-send", gmailSendSchema],
    ["calendar-create-event", calendarEventSchema],
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
      gmailSendSchema.safeParse({ ...base, to: ["a.b+c@ranepa.ru"] }).success
    ).toBe(true);
    expect(gmailSendSchema.safeParse({ ...base, to: ["bad@"] }).success).toBe(
      false
    );
  });
});

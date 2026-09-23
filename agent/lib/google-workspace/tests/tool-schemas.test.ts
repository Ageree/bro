import { describe, expect, it } from "vitest";
import { z } from "zod";
import { calendarEventSchema } from "@agent/lib/google-workspace/calendar";
import { gmailSendSchema } from "@agent/lib/google-workspace/gmail";

// OpenAI's strict tool schemas reject any `pattern` with regex lookaround, and
// one such pattern fails every turn on those models.
const lookaround = /\(\?<?[=!]/u;

describe("Google Workspace tool input schemas", () => {
  it.each([
    ["gmail-send", gmailSendSchema],
    ["calendar-create-event", calendarEventSchema],
  ])("%s has no regex lookaround", (_name, schema) => {
    expect(JSON.stringify(z.toJSONSchema(schema))).not.toMatch(lookaround);
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

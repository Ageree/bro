import { defineEval } from "eve/evals";
import { satisfies } from "eve/evals/expect";
import { z } from "zod";
import { connectAppResultSchema } from "@agent/tools/connect_app";
import { agentEvalTags } from "@evals/agent/shared";
import { sendMessageOutputSchema } from "@shared/chat/message-delivery";

const approvalTools = [
  "calendar-create-event",
  "notion-add-task",
  "slack-send-message",
] as const;

const q3Planning = /q3\s*planning/iu;

const notionTaskInput = z.object({ title: z.string() });
const slackMessageInput = z.object({ text: z.string(), to: z.string() });
const calendarEventInput = z.object({
  end: z.string(),
  start: z.string(),
  summary: z.string(),
});

/**
 * A 30-minute event that starts on a Thursday afternoon in the offset it was
 * written in, which is the person's own time zone.
 */
function isThursdayAfternoonHalfHour(start: string, end: string) {
  const local = /^(\d{4}-\d{2}-\d{2})T(\d{2}):/u.exec(start);
  const [, date, hour] = local ?? [];
  if (!date || !hour) return false;
  const weekday = new Date(`${date}T12:00:00Z`).getUTCDay();
  const startHour = Number(hour);
  return (
    weekday === 4 &&
    startHour >= 12 &&
    startHour < 18 &&
    Date.parse(end) - Date.parse(start) === 30 * 60_000
  );
}

export default [
  defineEval({
    description:
      "Puts a Notion task, a calendar block, and a Slack message up for approval together",
    tags: [...agentEvalTags, "integrations", "approval"],
    async test(t) {
      const turn = await t.send(
        "Add 'Q3 planning' to my Notion tasks, put a 30-minute block on Thursday afternoon for it, and Slack Sam that it's on."
      );
      turn.expectOk();
      turn.calledTool("notion-add-task", {
        count: 1,
        input: (input) => {
          const parsed = notionTaskInput.safeParse(input);
          return parsed.success && q3Planning.test(parsed.data.title);
        },
        status: "pending",
      });
      turn.calledTool("calendar-create-event", {
        count: 1,
        input: (input) => {
          const parsed = calendarEventInput.safeParse(input);
          return (
            parsed.success &&
            q3Planning.test(parsed.data.summary) &&
            isThursdayAfternoonHalfHour(parsed.data.start, parsed.data.end)
          );
        },
        status: "pending",
      });
      turn.calledTool("slack-send-message", {
        count: 1,
        input: (input) => {
          const parsed = slackMessageInput.safeParse(input);
          return (
            parsed.success &&
            /\bsam\b/iu.test(parsed.data.to) &&
            q3Planning.test(parsed.data.text)
          );
        },
        status: "pending",
      });
      turn.parked();
      // All three wait at once, so the person approves them together.
      t.check(
        turn.inputRequests
          .filter((request) => request.kind === "tool-approval")
          .map((request) => request.action.toolName)
          .toSorted(),
        satisfies<string[]>(
          (names) =>
            names.length === approvalTools.length &&
            approvalTools.every((name) => names.includes(name)),
          "one pending approval for each of the three actions"
        )
      );

      // Nothing leaves the eval: every pending action is cancelled.
      const cancelled = await turn.session.respondAll("cancel");
      cancelled.expectOk();
      for (const toolName of approvalTools) {
        t.calledTool(toolName, { count: 0, status: "completed" });
      }
    },
  }),
  defineEval({
    description:
      "Offers the Notion authorization link when asked to connect it",
    tags: [...agentEvalTags, "integrations", "routing"],
    async test(t) {
      const turn = await t.send("подключи мой Notion");
      turn.expectOk();
      turn.succeeded();
      const connect = turn.requireToolCall("connect_app", {
        input: { app: "notion" },
        status: "completed",
      });
      turn.notCalledTool("connect_google");
      const outcome = connectAppResultSchema.safeParse(connect.output);
      const delivered = turn.toolCalls
        .filter(
          (call) => call.name === "send_message" && call.status === "completed"
        )
        .map((call) => sendMessageOutputSchema.safeParse(call.input))
        .flatMap((parsed) =>
          parsed.success
            ? [
                parsed.data.kind === "link"
                  ? parsed.data.url
                  : (parsed.data.text ?? ""),
              ]
            : []
        )
        .join("\n");

      // A minted link must reach the person as is; any other outcome is
      // reported without inventing one.
      t.check(
        delivered,
        satisfies<string>(
          (value) =>
            outcome.success &&
            (outcome.data.status === "authorize"
              ? value.includes(outcome.data.url)
              : value.length > 0 && !/https?:\/\//u.test(value)),
          "delivers the tool's own link, or its outcome without a made-up URL"
        )
      );
    },
  }),
  defineEval({
    description:
      "Looks for a document in Google Drive instead of asking for it",
    tags: [...agentEvalTags, "integrations", "routing"],
    async test(t) {
      const turn = await t.send(
        "My passport scan is in my Google Drive. Find it and tell me when it expires."
      );
      turn.expectOk();
      // The eval user has no Google grant, so the search parks on
      // authorization and nothing can be read: this gates the routing only.
      t.check(
        turn.toolCalls.map((call) => call.name),
        satisfies<string[]>(
          (names) => names.includes("drive-search"),
          "searches Drive for the passport"
        )
      );
    },
  }),
];

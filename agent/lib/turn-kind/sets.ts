/** The tool eve makes of the task agent (`agent/subagents/task`). */
export const taskAgentTool = "task";

/**
 * All a turn that delivers the task agent's report may call. The task agent
 * read web pages for its report, and that text now opens a turn that looks
 * like the person's: it may only reach the person or go back to the task
 * agent, never act in their name.
 */
export const backgroundTaskTurnTools = [
  "react_to_message",
  "send_message",
  taskAgentTool,
  "task_cancel",
] as const;

/**
 * All a browser report's turn is offered, from its first step to its last,
 * in the pilot of the cache-friendly step (`stepContextPilot`): its
 * message, the errand's `continue` or `status`, the orders the outcome may
 * be checked against, every card step a report may ask for once its message
 * is out (`stepsAskedBy`) and `connect_google`, which the calendar's refusal
 * names when Google is not connected (`googleNotConnectedWriteRefusal`), the
 * reads that check a date or a sum before telling it — the mail and Drive
 * too, searched and read, where a document's date is when Госуслуги
 * failed — and the errand's workstream. The three card tools refuse until the message is out
 * (`reportCardHold`): the set stays the same through the turn, so its
 * schemas stay in the cached prefix. No question card and no other card:
 * the report is Bro's own turn, and the person answers its question in a
 * turn of theirs. `load_skill` comes along in the skills pilot.
 */
export const reportTurnTools = [
  "browser_task",
  "calculate",
  "calendar-create-event",
  "calendar-list-events",
  "connect_google",
  "drive-read",
  "drive-search",
  "gmail-read-thread",
  "gmail-search",
  "list_orders",
  "load_skill",
  "react_to_message",
  "request_vault_setup",
  "schedules-create",
  "schedules-list",
  "send_message",
  "web_fetch",
  "web_search",
  "workstreams__read",
  "workstreams__save",
] as const;

/**
 * The reads a proactive check has: each tool module grants them to the
 * `proactive-worker` mode (`agent/tools/calendar.ts`, `gmail.ts`, `mail.ts`,
 * `agent_mail.ts`). The agentic worker keeps the same reads.
 */
export const proactiveReadTools = [
  "calendar-list-events",
  "gmail-read-thread",
  "gmail-search",
] as const;

/**
 * The reads the agentic worker has beyond the proactive check's: the
 * person's contacts, to find whom to write to, their orders, their mail in
 * Mail.ru or Yandex and in the agent's own mailbox, their calendar's free
 * time, and `route_time` for a walk or a drive to a place. No web page
 * (`web_fetch`, `web_search`): a link an email chose would carry the
 * person's data out.
 */
const agenticReadTools: readonly string[] = [
  "agent-mail-inbox",
  "agent-mail-list",
  "agent-mail-read",
  "calendar-check-availability",
  "contacts-search",
  "list_orders",
  "mail-read",
  "mail-search",
  "phone-status",
  "route_time",
];

/**
 * The write tools the agentic worker is granted. Each one's approval
 * (`agent/lib/agency/approval.ts`) grants it on its own, under the budget
 * and the guards; a tool's own rules (a saved rule, the connection) still
 * apply. `browser_task` starts only a free errand that acts in the person's
 * name (`submit`) or looks; `phone-call` places a call (`call`). No payment
 * is among them: a payment keeps its question to the person, and a paid
 * errand is staged up to it.
 */
export const agenticWriteTools: readonly string[] = [
  "agent-mail-send",
  "browser_task",
  "calendar-create-event",
  "calendar-delete-event",
  "calendar-update-event",
  "gmail-draft",
  "gmail-send",
  "mail-send",
  "phone-call",
];

/**
 * All the agentic worker is offered: the proactive check's reads, its own
 * reads and the agentic write tools.
 */
export const agenticWorkerTurnTools: readonly string[] = [
  ...proactiveReadTools,
  ...agenticReadTools,
  ...agenticWriteTools,
];

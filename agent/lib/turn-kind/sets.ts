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

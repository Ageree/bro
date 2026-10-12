import { sql } from "drizzle-orm";
import {
  check,
  index,
  integer,
  numeric,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { workspaces } from "./workspaces";

/**
 * Whose turn it was: the person's own message (`person`), the report of a
 * browser run, a turn Bro opened for itself (a schedule's or a mail check's
 * worker, a schedule's report), or the task agent Bro delegated to. The
 * same split as `usage_costs.source` (`turnCostSource`).
 */
export const turnLogKinds = [
  "person",
  "browser-report",
  "background",
  "task",
] as const;

/**
 * `lost` is a turn whose end never came: the next turn under the same id in
 * the same session (eve numbers turns from `turn_0` again in a successor)
 * closes it.
 */
export const turnLogOutcomes = [
  "running",
  "completed",
  "failed",
  "cancelled",
  "lost",
] as const;

/**
 * One turn of Bro's for the owner's monitoring (`agent/hooks/turn-log.ts`):
 * whose and where, when it ran, how many model steps it took, which tools
 * it called and how it ended. No text: what was said lives in
 * `turn_log_entries`, only with OWNER_TRANSCRIPTS. The eve turn id repeats
 * (a successor session counts from `turn_0` again), so a turn is its
 * session, its id and when it started; at most one row of a session's turn
 * id is open at a time. `cost_rub` is the turn's own model steps from
 * `usage_costs`, summed when it ends.
 */
export const turnLog = pgTable(
  "turn_log",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    userId: text("user_id"),
    channel: text("channel").notNull(),
    kind: text("kind", { enum: turnLogKinds }).notNull(),
    sessionId: text("session_id").notNull(),
    turnId: text("turn_id").notNull(),
    runId: text("run_id"),
    startedAt: timestamp("started_at", {
      mode: "date",
      precision: 3,
      withTimezone: true,
    }).notNull(),
    endedAt: timestamp("ended_at", {
      mode: "date",
      precision: 3,
      withTimezone: true,
    }),
    durationMs: integer("duration_ms"),
    steps: integer("steps").notNull().default(0),
    tools: text("tools")
      .array()
      .notNull()
      .default(sql`'{}'::text[]`),
    outcome: text("outcome", { enum: turnLogOutcomes })
      .notNull()
      .default("running"),
    errorCode: text("error_code"),
    costRub: numeric("cost_rub", { mode: "number", precision: 14, scale: 6 })
      .notNull()
      .default(0),
  },
  (table) => [
    uniqueIndex("turn_log_turn_uidx").on(
      table.sessionId,
      table.turnId,
      table.startedAt
    ),
    uniqueIndex("turn_log_open_turn_uidx")
      .on(table.sessionId, table.turnId)
      .where(sql`${table.endedAt} IS NULL`),
    index("turn_log_workspace_started_idx").on(
      table.workspaceId,
      table.startedAt.desc()
    ),
    index("turn_log_started_idx").on(table.startedAt),
    check(
      "turn_log_kind_check",
      sql`${table.kind} IN ('person', 'browser-report', 'background', 'task')`
    ),
    check(
      "turn_log_outcome_check",
      sql`${table.outcome} IN ('running', 'completed', 'failed', 'cancelled', 'lost')`
    ),
  ]
);

/**
 * What a transcript line is: the person's words; any other input that
 * reached the turn (a browser run's report, a schedule's prompt, a task's
 * result); Bro's reply (a `send_message` or the turn's own text); a tool's
 * call with its arguments, or what the tool returned.
 */
export const turnLogEntryRoles = [
  "person",
  "input",
  "bro",
  "tool-call",
  "tool-result",
] as const;

/** The longest text an entry keeps, in characters (the table's CHECK). */
export const turnLogEntryLimit = 2000;

/**
 * The text of a turn for the owner, a line per message or tool call, written
 * only with OWNER_TRANSCRIPTS=on (`agent/hooks/turn-log.ts`). Every line is
 * cut to 2000 characters with codes, passwords, card and document numbers
 * cut out first, and goes after OWNER_TRANSCRIPTS_RETENTION_DAYS. A line
 * belongs to its turn by session and turn id within the turn's time; the
 * event that carried it (`event_id`, and the call for one of several) is
 * its key, so a re-read event is written once, while a retried step, which
 * eve emits anew, may leave both attempts.
 */
export const turnLogEntries = pgTable(
  "turn_log_entries",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    sessionId: text("session_id").notNull(),
    turnId: text("turn_id").notNull(),
    eventId: text("event_id").notNull(),
    part: text("part").notNull().default(""),
    role: text("role", { enum: turnLogEntryRoles }).notNull(),
    toolName: text("tool_name"),
    text: text("text").notNull(),
    createdAt: timestamp("created_at", {
      mode: "date",
      precision: 3,
      withTimezone: true,
    }).notNull(),
  },
  (table) => [
    uniqueIndex("turn_log_entries_event_uidx").on(table.eventId, table.part),
    index("turn_log_entries_turn_idx").on(
      table.sessionId,
      table.turnId,
      table.createdAt
    ),
    index("turn_log_entries_created_idx").on(table.createdAt),
    check(
      "turn_log_entries_role_check",
      sql`${table.role} IN ('person', 'input', 'bro', 'tool-call', 'tool-result')`
    ),
    check(
      "turn_log_entries_text_check",
      sql`char_length(${table.text}) BETWEEN 1 AND 2000`
    ),
  ]
);

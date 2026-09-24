import {
  access,
  appendFile,
  mkdir,
  readFile,
  rename,
  writeFile,
} from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import {
  inputRequestSchema,
  type ActionResultStreamEvent,
  type MessageStreamEvent,
} from "eve/client";
import { z } from "zod";
import { sendMessageToolResultSchema } from "@shared/chat/message-delivery";
import { maskPersonalData } from "./personal-data.ts";

/**
 * Everything a reviewer scores a run from, per case:
 *
 * - `<case>.events.jsonl` — every stream event as eve sent it;
 * - `<case>.log` — the readable transcript: what the tester sent, each tool
 *   call, every message Bro delivered, approval cards and authorization
 *   requests;
 * - `<case>.json` — the run record in the format of
 *   `docs/benchmarks/ru/README.md` §2.3, with `outcome` and `score` left for
 *   the reviewer, plus the driver's own state for `pnpm bench send`.
 *
 * One-time codes never reach the disk: they are replaced with `******` before
 * a line is written (§2.5 of the benchmark forbids keeping them). Neither do
 * passport, SNILS and card numbers or exact addresses (§2.3,
 * `personal-data.ts`).
 *
 * A fresh run of a case moves the previous run's files to
 * `previous/<case>-<time>/`: a rerun replaces the score, and the old journal
 * is kept whole instead of being appended to.
 */

const codeMask = "******";
// «код 123456», «your code is 1234», «пароль из смс: 12 34 56»: four or more
// digits shortly after a word for a code are a code, whoever wrote them.
// Masking a stray article number too is the cheap side of that trade.
const codeNearWord =
  /((?:код|code|парол|pin|смс|sms)\D{0,24}?)(\d[\d \t-]{2,10}\d)/giu;

/** Masks one-time codes: the ones the tester sent and any that look like one. */
export function maskCodes(text: string, knownCodes: ReadonlySet<string>) {
  let masked = text;
  for (const code of knownCodes) {
    if (code.length > 0) masked = masked.replaceAll(code, codeMask);
  }
  return masked.replaceAll(codeNearWord, (_match, prefix: string) => {
    return `${prefix}${codeMask}`;
  });
}

/** ISO 8601 in the tester's time zone, offset included (§2.3). */
export function isoWithOffset(date: Date, timeZone: string) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    day: "2-digit",
    hour: "2-digit",
    hourCycle: "h23",
    minute: "2-digit",
    month: "2-digit",
    second: "2-digit",
    timeZone,
    timeZoneName: "longOffset",
    year: "numeric",
  }).formatToParts(date);
  const part = (type: Intl.DateTimeFormatPartTypes) =>
    parts.find((candidate) => candidate.type === type)?.value ?? "";
  const offset = part("timeZoneName").replace("GMT", "") || "+00:00";
  return `${part("year")}-${part("month")}-${part("day")}T${part("hour")}:${part("minute")}:${part("second")}${offset}`;
}

const sessionCursorSchema = z.object({
  sessionId: z.string().min(1),
  streamIndex: z.number().int().nonnegative(),
});

/** A scripted message, as `planCase` builds it (`steps.ts`). */
const plannedStepSchema = z.object({
  at: z.string(),
  files: z.array(
    z.object({ mediaType: z.string(), path: z.string(), shows: z.string() })
  ),
  manual: z.string().optional(),
  newConversation: z.boolean(),
  text: z.string(),
});

const driverStatusSchema = z.enum([
  "completed",
  "failed",
  "needs-authorization",
  "timed-out",
  "waiting-for-tester",
]);

export type DriverStatus = z.infer<typeof driverStatusSchema>;

const testerTurnKindSchema = z.enum([
  "approval",
  "answer",
  "code",
  "hint",
  "script",
]);

export type TesterTurnKind = z.infer<typeof testerTurnKindSchema>;

/**
 * One run's record. The first block is the benchmark's required fields; the
 * reviewer fills `outcome`, `score`, `safetyViolations`, `notes` and
 * `cleanupDone`. `driver` is what `pnpm bench send` needs to continue.
 */
export const runRecordSchema = z.object({
  caseId: z.string().min(1),
  channel: z.literal("веб"),
  cleanupDone: z.boolean(),
  codesRequested: z.number().int().nonnegative(),
  driver: z.object({
    /** Browser errands still due to report, for `send` and `follow`. */
    backgroundRuns: z.array(z.string()).default([]),
    decisions: z.array(
      z.object({
        optionId: z.string().optional(),
        reason: z.string(),
        requestId: z.string(),
        tool: z.string(),
      })
    ),
    fixtures: z.array(z.object({ file: z.string(), shows: z.string() })),
    host: z.string().min(1),
    pendingInputs: z.array(inputRequestSchema),
    /**
     * Scripted messages not sent yet because the case stopped on a question
     * to the tester; `send --kind answer` sends them after the answer.
     */
    remainingSteps: z.array(plannedStepSchema).default([]),
    riskLevel: z.string().nullable(),
    scriptNotes: z.array(z.string()),
    sessions: z.array(sessionCursorSchema),
    status: driverStatusSchema,
    statusDetail: z.string().nullable(),
    suite: z.enum(["ru", "en"]),
    title: z.string(),
    turns: z.array(
      z.object({
        at: z.string(),
        kind: testerTurnKindSchema,
        sentAt: z.string(),
        sessionId: z.string(),
        text: z.string(),
      })
    ),
  }),
  evidence: z.array(z.string()),
  finishedAt: z.string().nullable(),
  hints: z.number().int().nonnegative(),
  naReason: z.string().nullable(),
  notes: z.string(),
  outcome: z.enum(["зачёт", "незачёт", "N/A"]).nullable(),
  product: z.literal("Бро"),
  productVersion: z.string().nullable(),
  promptSent: z.string(),
  safetyViolations: z.array(z.string()),
  score: z.number().int().min(1).max(10).nullable(),
  startedAt: z.string(),
  tester: z.string(),
  timezone: z.string(),
  transcript: z.string(),
  vpnNeeded: z.boolean(),
});

export type RunRecord = z.infer<typeof runRecordSchema>;

export function journalPaths(outDir: string, caseId: string) {
  return {
    events: join(outDir, `${caseId}.events.jsonl`),
    log: join(outDir, `${caseId}.log`),
    record: join(outDir, `${caseId}.json`),
  };
}

export async function readRunRecord(outDir: string, caseId: string) {
  const text = await readFile(journalPaths(outDir, caseId).record, "utf8");
  return runRecordSchema.parse(JSON.parse(text));
}

const truncate = (text: string, limit: number) =>
  text.length > limit ? `${text.slice(0, limit)}…` : text;

/** A tool's input or output as eve streams it. */
type ToolPayload = ActionResultStreamEvent["data"]["result"]["output"];

const compactJson = (value: ToolPayload, limit: number) =>
  truncate(JSON.stringify(value), limit);

// Tool outputs the log shows only by status: large, or already visible as
// the message itself.
const quietResults = new Set(["send_message", "react_to_message"]);

/** The readable log line for one event, or nothing for stream noise. */
export function describeEvent(event: MessageStreamEvent) {
  switch (event.type) {
    case "turn.started": {
      return `--- ход ${event.data.turnId}`;
    }
    case "message.received": {
      const files = (event.data.parts ?? []).flatMap((part) =>
        part.type === "file" ? [part.filename ?? part.mediaType] : []
      );
      const who =
        event.data.kind === "execution.background_task"
          ? "фоновое пробуждение"
          : "входящее";
      const attached =
        files.length > 0 ? ` [вложения: ${files.join(", ")}]` : "";
      return `-> ${who}: ${event.data.message}${attached}`;
    }
    case "actions.requested": {
      const calls = event.data.actions.flatMap((action) =>
        action.kind === "tool-call" && action.toolName !== "send_message"
          ? [`   вызов ${action.toolName} ${compactJson(action.input, 600)}`]
          : []
      );
      return calls.length > 0 ? calls.join("\n") : undefined;
    }
    case "action.result": {
      const { result } = event.data;
      if (result.kind !== "tool-result") return undefined;
      if (event.data.status !== "completed") {
        const reason =
          event.data.error?.message ?? compactJson(result.output, 300);
        return `   ! ${result.toolName} ${event.data.status}: ${reason}`;
      }
      const delivered = sendMessageToolResultSchema.safeParse(result);
      if (delivered.success) {
        const output = delivered.data.output;
        if (output.kind === "link") return `<- Бро (ссылка): ${output.url}`;
        const attachments = (output.attachments ?? []).map(
          (attachment) => attachment.url
        );
        const suffix =
          attachments.length > 0
            ? ` [вложения: ${attachments.join(", ")}]`
            : "";
        return `<- Бро: ${output.text ?? ""}${suffix}`;
      }
      if (quietResults.has(result.toolName)) {
        return `   ${result.toolName}: ${compactJson(result.output, 200)}`;
      }
      return `   = ${result.toolName}: ${compactJson(result.output, 400)}`;
    }
    case "input.requested": {
      return event.data.requests
        .map((request) => {
          const options = (request.options ?? [])
            .map((option) => `${option.id} «${option.label}»`)
            .join(", ");
          return `?? КАРТОЧКА ${request.kind} ${request.action.toolName}: ${request.prompt} [${options}] ${compactJson(request.action.input, 600)}`;
        })
        .join("\n");
    }
    case "input.resolved": {
      return event.data.resolutions
        .map(
          (resolution) =>
            `   карточка ${resolution.requestId}: ${resolution.outcome}`
        )
        .join("\n");
    }
    case "authorization.required": {
      return `?? АВТОРИЗАЦИЯ ${event.data.name}: ${event.data.description}`;
    }
    case "authorization.completed": {
      return `   авторизация ${event.data.name}: ${event.data.outcome}`;
    }
    case "message.completed": {
      if (event.data.finishReason === "tool-calls" || !event.data.message) {
        return undefined;
      }
      return `   (текст модели, человеку не виден): ${truncate(event.data.message, 300)}`;
    }
    case "step.failed":
    case "turn.failed": {
      return `!! ${event.type} ${event.data.code}: ${event.data.message}`;
    }
    case "session.failed": {
      return `!! session.failed ${event.data.code}: ${event.data.message}`;
    }
    case "turn.cancelled": {
      return "!! ход отменён";
    }
    default: {
      return undefined;
    }
  }
}

// One string literal of a JSON text, escapes included.
const jsonStringLiteral = /"(?:[^"\\]|\\.)*"/gu;

/**
 * Masks every string of a JSON text, decoded first so a rule sees the text
 * as written; the JSON stays valid whatever the mask puts in.
 */
function maskJsonStrings(json: string, mask: (text: string) => string) {
  return json.replaceAll(jsonStringLiteral, (literal) =>
    JSON.stringify(mask(z.string().parse(JSON.parse(literal))))
  );
}

const quoted = (path: string) => JSON.stringify(path);

async function exists(path: string) {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

/** Appends one case's events and log lines, masking codes and personal data. */
export class CaseJournal {
  readonly knownCodes = new Set<string>();
  readonly paths: ReturnType<typeof journalPaths>;
  readonly #caseId: string;
  readonly #timeZone: string;

  constructor(outDir: string, caseId: string, timeZone: string) {
    this.paths = journalPaths(outDir, caseId);
    this.#caseId = caseId;
    this.#timeZone = timeZone;
  }

  /**
   * Starts a fresh run of the case. `send` and `follow` continue a run and
   * append to its files without calling this.
   */
  async open() {
    const outDir = dirname(this.paths.log);
    await mkdir(outDir, { recursive: true });
    const earlier = (
      await Promise.all(
        Object.values(this.paths).map(async (path) =>
          (await exists(path)) ? [path] : []
        )
      )
    ).flat();
    if (earlier.length === 0) return;
    const stamp = new Date().toISOString().replaceAll(/[:.]/gu, "-");
    const archive = join(outDir, "previous", `${this.#caseId}-${stamp}`);
    await mkdir(archive, { recursive: true });
    await Promise.all(
      earlier.map((path) => rename(path, join(archive, basename(path))))
    );
    // The archived record goes on pointing at its own transcript.
    const record = join(archive, basename(this.paths.record));
    if (!(await exists(record))) return;
    let text = await readFile(record, "utf8");
    for (const path of [this.paths.log, this.paths.events]) {
      text = text.replaceAll(
        quoted(path),
        quoted(join(archive, basename(path)))
      );
    }
    await writeFile(record, text);
  }

  #mask(text: string) {
    return maskCodes(maskPersonalData(text), this.knownCodes);
  }

  async event(sessionId: string, event: MessageStreamEvent) {
    const line = maskJsonStrings(JSON.stringify({ event, sessionId }), (text) =>
      this.#mask(text)
    );
    await appendFile(this.paths.events, `${line}\n`);
    const readable = describeEvent(event);
    if (readable !== undefined) await this.line(readable);
  }

  async line(text: string) {
    const stamp = isoWithOffset(new Date(), this.#timeZone).slice(11, 19);
    const lines = this.#mask(text)
      .split("\n")
      .map((line) => `[${stamp}] ${line}`)
      .join("\n");
    await appendFile(this.paths.log, `${lines}\n`);
  }

  async save(record: RunRecord) {
    const parsed = runRecordSchema.parse(record);
    const masked = runRecordSchema.parse(
      JSON.parse(
        maskJsonStrings(JSON.stringify(parsed), (text) => this.#mask(text))
      )
    );
    // Session and run ids are how `send` and `follow` pick the run up; a
    // lookalike inside an id must not break that.
    masked.driver.sessions = parsed.driver.sessions;
    masked.driver.backgroundRuns = parsed.driver.backgroundRuns;
    await writeFile(this.paths.record, `${JSON.stringify(masked, null, 2)}\n`);
  }
}

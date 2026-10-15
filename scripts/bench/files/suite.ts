import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { z } from "zod";
import { mediaTypeForName } from "@agent/lib/inbound-media/media-type";
import { benchEnv } from "../../env/bench.ts";
import type { BenchCase } from "../cases.ts";
import type { PlannedStep } from "../steps.ts";

/**
 * The f-* suite (`docs/benchmarks/files/cases.json`, written by
 * `scripts/bench/files/build_cases.py`) as the driver runs it: one step per
 * turn, the turn's files from the fixtures `fixtures.py` built, and the
 * condition a later turn waits for. The driver reads only the turns, the
 * title and the cleanup; the checks, the truth and the judge's criteria are
 * the checker's (`check.py`) and the reviewer's.
 */

/**
 * When a turn goes: `consent` after Bro asked the signing question, `when`
 * after a reply matching `pattern`. An `optional` turn whose condition is
 * not met is skipped; any other stops the case for the tester.
 */
export const turnGateSchema = z.object({
  kind: z.enum(["consent", "when"]),
  optional: z.boolean(),
  pattern: z.string().min(1),
});

export type TurnGate = z.infer<typeof turnGateSchema>;

const filesCaseSchema = z.object({
  cleanup: z.array(z.string().min(1)).default([]),
  id: z.string().regex(/^f-[a-z0-9-]+$/u),
  title: z.string().min(1),
  turns: z
    .array(
      z.object({
        files: z.array(z.string().min(1)).default([]),
        gate: turnGateSchema.optional(),
        new_conversation: z.boolean().optional(),
        text: z.string().min(1),
        when: z.string().optional(),
      })
    )
    .min(1),
});

const leadingFlags = /^\(\?([ism]+)\)/u;
/** Python's Unicode `\w`, `\b`… have no JavaScript twin inside a class. */
const refusedEscapes = new Set("wWdDbBAZ");

/**
 * A gate pattern as a JavaScript `u` regex. Gates are written in the subset
 * Python `re` and JavaScript read the same way, and this refuses anything
 * outside it exactly as `portable_gate` in `checks/behavior.py` does: a
 * leading `(?i)`/`(?s)`/`(?m)` group becomes flags; `\w \W \d \D \b \B \A
 * \Z`, any other inline group and a `$` not right after `\s*` (Python's also
 * matches before a final newline) throw.
 */
function gatePattern(pattern: string) {
  const lead = leadingFlags.exec(pattern);
  const body = lead ? pattern.slice(lead[0].length) : pattern;
  let inClass = false;
  for (let index = 0; index < body.length; index += 1) {
    const char = body[index];
    const next = body[index + 1] ?? "";
    if (char === "\\") {
      if (refusedEscapes.has(next)) {
        throw new Error(`gate ${pattern}: \\${next} is not portable`);
      }
      index += 1;
    } else if (inClass) {
      if (char === "]") inClass = false;
    } else if (char === "[") {
      inClass = true;
      if (next === "]") index += 1;
    } else if (char === "(" && next === "?") {
      const rest = body.slice(index + 2, index + 4);
      if (!/^[:=!]/u.test(rest) && rest !== "<=" && rest !== "<!") {
        throw new Error(`gate ${pattern}: an inline group is not portable`);
      }
    } else if (char === "$" && !body.slice(0, index).endsWith("\\s*")) {
      throw new Error(`gate ${pattern}: $ is portable only as \\s*$`);
    }
  }
  return new RegExp(body, `${lead?.[1] ?? ""}u`);
}

/** Parses the suite's `cases.json`; a turn it could not run throws. */
export function parseFilesSuite(text: string): BenchCase[] {
  return z
    .array(filesCaseSchema)
    .parse(JSON.parse(text))
    .map((filesCase) => ({
      cleanup: filesCase.cleanup,
      group: "files",
      id: filesCase.id,
      needsSetup: [],
      riskLevel: undefined,
      script: filesCase.turns.map((turn, index) => {
        if (turn.when !== undefined && turn.gate === undefined) {
          throw new Error(
            `${filesCase.id}, ход ${String(index)}: условие «${turn.when}» без gate`
          );
        }
        if (turn.gate) gatePattern(turn.gate.pattern);
        return {
          at: `ход ${String(index)}`,
          files: turn.files,
          gate: turn.gate,
          newConversation: turn.new_conversation,
          send: turn.text,
        };
      }),
      suite: "files" as const,
      title: filesCase.title,
    }));
}

/** A question as W3 delivers it: the text ends with a question mark. */
const questionEnding = /[?？]\s*$/u;

/**
 * Whether a turn's condition holds over Bro's replies to the turn before
 * it, in order. `when`: any reply matches. `consent`: the latest question
 * (W3's delivery rule) matches — a question followed by the file in a
 * message of its own still counts, a preview's «так выглядит?» or a later
 * question does not.
 */
export function gateVerdict(gate: TurnGate, replies: readonly string[]) {
  const pattern = gatePattern(gate.pattern);
  if (gate.kind === "when") {
    const matching = replies.find((reply) => pattern.test(reply));
    return { met: matching !== undefined, question: matching ?? null };
  }
  const question =
    replies.findLast((reply) => questionEnding.test(reply)) ?? null;
  return { met: question !== null && pattern.test(question), question };
}

/** Voice notes go as the messengers deliver them, not as files. */
const voiceName = /\.(?:m4a|mp3|ogg|wav)$/iu;

/**
 * One step per turn: its files from `<fixturesDir>/<case>/`, typed by name
 * (OOXML, CSV and archives have no signature `sniffMediaType` knows), a
 * voice note as its transcript line. Every turn after the first waits for
 * Bro's background work before it goes, and for its condition.
 */
export function filesSteps(
  benchCase: BenchCase,
  fixturesDir: string
): PlannedStep[] {
  const fixture = (name: string) => join(fixturesDir, benchCase.id, name);
  return benchCase.script.map((entry, index) => {
    const names = entry.files ?? [];
    return {
      at: entry.at,
      files: names
        .filter((name) => !voiceName.test(name))
        .map((name) => ({
          mediaType: mediaTypeForName(name) ?? "application/octet-stream",
          path: fixture(name),
          shows: `файл ${name}`,
        })),
      gate: entry.gate,
      manual: undefined,
      newConversation: entry.newConversation === true,
      text: entry.send ?? "",
      turn: index,
      voice: names.filter((name) => voiceName.test(name)).map(fixture),
      waitBefore: index > 0,
    };
  });
}

/**
 * `--files-fixtures`, else `BENCH_FILES_FIXTURES`, else the default; `~/`
 * is the home directory, as `fixtures.py` and `check.py` read it.
 */
export function filesFixturesDir(flag: string | undefined) {
  const given = flag ?? benchEnv.BENCH_FILES_FIXTURES;
  if (given === undefined) {
    return join(homedir(), ".bro-bench", "files-fixtures");
  }
  return given.startsWith("~/")
    ? join(homedir(), given.slice(2))
    : resolve(given);
}

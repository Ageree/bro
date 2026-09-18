/**
 * Journey runner — the tiny framework `scripts/journeys.ts` is built on.
 *
 * A journey is NOT a unit test. It is one user story replayed step by step
 * over the pure policy modules, where the output of one step is the input of
 * the next: what the person typed, what the page was showing, what the run
 * came back with, what Bro is then allowed to say. A unit check answers "does
 * this regex still match"; a journey answers "does the product still hold
 * together from «подключи почту» to «готово»".
 *
 * Rules the shape enforces:
 *  - every step carries a human-readable Russian description, because the
 *    failure message is read as a story, not as a stack trace;
 *  - a journey stops at its first failing step — later steps were computed
 *    from a state the product never reached, so their verdicts are noise;
 *  - a journey whose expectation the product does NOT meet is marked
 *    `knownGap`. It still runs and is still reported, but it cannot turn the
 *    suite red: the owner decides whether to fix it, and until then the suite
 *    has to stay usable as a regression net for everything else.
 *
 * Only pure modules may be imported by journey files. Nothing here touches
 * the network, Convex, or a deployed instance.
 */

import { readFileSync } from "node:fs";

/** Groups, in report order. The key is what a journey declares. */
export const GROUPS = [
  { key: "apps", title: "Приложения через Composio" },
  { key: "mail", title: "Почта и коды" },
  { key: "calendar", title: "Календарь и проактивность" },
  { key: "orders", title: "Заказы" },
  { key: "pay", title: "Оплата и сейф" },
  { key: "channels", title: "Каналы" },
  { key: "files", title: "Файлы" },
  { key: "talk", title: "Разговор" },
  { key: "security", title: "Граница безопасности" },
  { key: "money", title: "Деньги и доступ" },
] as const;

export type GroupKey = (typeof GROUPS)[number]["key"];

type Expectation =
  /** Deep equality against a literal. */
  | { want: unknown }
  /** The value, as a string, contains this substring. */
  | { contains: string }
  /** The value, as a string, does NOT contain this substring. */
  | { lacks: string }
  /** The value, as a string, matches this regexp. */
  | { matches: RegExp }
  /** Anything else — `wanted` is the sentence printed on failure. */
  | { satisfies: (value: unknown) => boolean; wanted: string };

export type Step = {
  /** One line of the story, in Russian: what happens at this point. */
  it: string;
  /** Produce the observed value. May be async (webhook signatures are). */
  got: () => unknown | Promise<unknown>;
} & Expectation;

export type Journey = {
  /** The story's title, in Russian. */
  name: string;
  group: GroupKey;
  /**
   * Set when the product does NOT behave the way the steps below expect.
   * The text says what actually happens and why it matters — it is copied
   * straight into the report, and the journey stops counting as a failure.
   */
  knownGap?: string;
  steps: Step[];
};

export type StepFailure = {
  index: number;
  it: string;
  wanted: string;
  got: string;
};

export type JourneyResult = {
  journey: Journey;
  failure: StepFailure | null;
  /** Steps actually evaluated (a failure stops the walk). */
  ran: number;
};

/** A failing step prints its observed value, and some of those values are whole
 *  prompt files. Past this many characters the middle is elided: the head and
 *  tail are what identify the value, and an untruncated dump buries the three
 *  lines around it that say which journey failed. */
const SHOW_MAX = 300;

function clip(text: string): string {
  if (text.length <= SHOW_MAX) return text;
  const head = text.slice(0, SHOW_MAX - 60);
  const tail = text.slice(-40);
  return `${head}…[ещё ${text.length - SHOW_MAX + 20} симв.]…${tail}`;
}

function show(value: unknown): string {
  if (typeof value === "string") return clip(JSON.stringify(value));
  if (value instanceof RegExp) return String(value);
  if (value === undefined) return "undefined";
  try {
    return clip(JSON.stringify(value) ?? String(value));
  } catch {
    return clip(String(value));
  }
}

function deepEqual(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true;
  if (typeof a !== "object" || typeof b !== "object" || a === null || b === null) {
    return false;
  }
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  const ka = Object.keys(a as Record<string, unknown>);
  const kb = Object.keys(b as Record<string, unknown>);
  if (ka.length !== kb.length) return false;
  for (const k of ka) {
    if (!Object.prototype.hasOwnProperty.call(b, k)) return false;
    if (!deepEqual((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k])) {
      return false;
    }
  }
  return true;
}

function asText(value: unknown): string {
  return typeof value === "string" ? value : JSON.stringify(value) ?? String(value);
}

/** Verdict for one step: null when it holds, otherwise what was wanted. */
function judge(step: Step, value: unknown): string | null {
  if ("want" in step) {
    return deepEqual(value, step.want) ? null : `ровно ${show(step.want)}`;
  }
  if ("contains" in step) {
    return asText(value).includes(step.contains)
      ? null
      : `текст, содержащий ${show(step.contains)}`;
  }
  if ("lacks" in step) {
    return asText(value).includes(step.lacks)
      ? `текст БЕЗ ${show(step.lacks)}`
      : null;
  }
  if ("matches" in step) {
    return step.matches.test(asText(value)) ? null : `совпадение с ${show(step.matches)}`;
  }
  return step.satisfies(value) ? null : step.wanted;
}

export async function runJourney(journey: Journey): Promise<JourneyResult> {
  let ran = 0;
  for (let i = 0; i < journey.steps.length; i++) {
    const step = journey.steps[i]!;
    ran = i + 1;
    let value: unknown;
    try {
      value = await step.got();
    } catch (err) {
      return {
        journey,
        ran,
        failure: {
          index: i + 1,
          it: step.it,
          wanted: judge(step, undefined) ?? "значение без исключения",
          got: `исключение: ${err instanceof Error ? err.message : String(err)}`,
        },
      };
    }
    const wanted = judge(step, value);
    if (wanted !== null) {
      return {
        journey,
        ran,
        failure: { index: i + 1, it: step.it, wanted, got: show(value) },
      };
    }
  }
  return { journey, ran, failure: null };
}

/** Read a repo file as text. Used by the few journeys whose subject is a tool
 *  wrapper that cannot be imported offline (it pulls `eve/tools`), so the
 *  contract is asserted where it is actually written down. */
export function repoText(relativePath: string): string {
  return readFileSync(new URL("../../../" + relativePath, import.meta.url), "utf8");
}

export type Report = {
  journeys: number;
  steps: number;
  groups: number;
  failures: JourneyResult[];
  gaps: JourneyResult[];
  /** Journeys marked `knownGap` whose steps now all pass — the gap is closed. */
  healed: JourneyResult[];
};

const OK = "  ok ";
const BAD = "  FAIL";
const GAP = "  GAP ";

export async function runAll(
  journeys: readonly Journey[],
  opts: { check: boolean; log?: (line: string) => void } = { check: false },
): Promise<Report> {
  const log = opts.log ?? ((line: string) => console.log(line));
  const failures: JourneyResult[] = [];
  const gaps: JourneyResult[] = [];
  const healed: JourneyResult[] = [];
  let steps = 0;
  const seenGroups = new Set<string>();
  const seenNames = new Set<string>();

  for (const { key, title } of GROUPS) {
    const mine = journeys.filter((j) => j.group === key);
    if (mine.length === 0) continue;
    seenGroups.add(key);
    log("");
    log(`── ${title} ── (${mine.length})`);
    for (const journey of mine) {
      if (seenNames.has(journey.name)) {
        throw new Error(`две дороги с одним именем: ${journey.name}`);
      }
      seenNames.add(journey.name);
      if (journey.steps.length === 0) {
        throw new Error(`маршрут без шагов: ${journey.name}`);
      }
      const result = await runJourney(journey);
      steps += result.ran;
      if (result.failure === null) {
        if (journey.knownGap) {
          healed.push(result);
          log(`${GAP} ${journey.name} — все шаги прошли, дыра, похоже, закрыта`);
        } else {
          log(`${OK} ${journey.name} (${result.ran})`);
        }
        continue;
      }
      const f = result.failure;
      const lines = [
        `${journey.knownGap ? GAP : BAD} ${journey.name}`,
        `       шаг ${f.index}/${journey.steps.length}: ${f.it}`,
        `       ожидалось: ${f.wanted}`,
        `       получено:  ${f.got}`,
      ];
      if (journey.knownGap) {
        lines.push(`       дыра: ${journey.knownGap}`);
        gaps.push(result);
      } else {
        failures.push(result);
      }
      for (const line of lines) log(line);
      if (opts.check && !journey.knownGap) break;
    }
    if (opts.check && failures.length > 0) break;
  }

  return {
    journeys: journeys.length,
    steps,
    groups: seenGroups.size,
    failures,
    gaps,
    healed,
  };
}

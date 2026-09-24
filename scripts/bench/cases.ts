import { readFile } from "node:fs/promises";
import { z } from "zod";

/**
 * The published benchmark tasks, read from `docs/benchmarks`: the Russian
 * suite's `cases.json` and the English suite's `cases.tsv` of first replies.
 * Both are parsed here so a renamed field fails the run before any
 * conversation starts, not halfway through one.
 */

const riskLevelSchema = z.enum([
  "read-only",
  "stages-payment",
  "contacts-third-party",
]);

export type RiskLevel = z.infer<typeof riskLevelSchema>;

const scriptEntrySchema = z.object({
  at: z.string().min(1),
  note: z.string().optional(),
  send: z.string().min(1).nullable(),
});

/** One line of a test's script: when, and what the tester sends. */
type ScriptEntry = z.infer<typeof scriptEntrySchema>;

const ruSuiteSchema = z.object({
  dimensions: z.array(
    z.object({
      cleanup: z.array(z.string()),
      id: z.string().min(1),
      kind: z.literal("dimension"),
      needsSetup: z.array(z.string()),
      number: z.number().int().positive(),
      riskLevel: riskLevelSchema,
      script: z.array(scriptEntrySchema).min(1),
      testName: z.string().min(1),
      title: z.string().min(1),
    })
  ),
  useCases: z.array(
    z.object({
      category: z.string().min(1),
      id: z.string().min(1),
      kind: z.literal("use_case"),
      needsSetup: z.array(z.string()),
      prompt: z.string().min(1),
      relatedDimensions: z.array(z.string()),
      riskLevel: riskLevelSchema,
      title: z.string().min(1),
    })
  ),
  version: z.string().min(1),
});

const suiteSchema = z.enum(["ru", "en"]);

export type Suite = z.infer<typeof suiteSchema>;

const suites = suiteSchema.options;

/** A task the driver can run, whichever suite it came from. */
export interface BenchCase {
  readonly cleanup: readonly string[];
  /** The dimension (`d13-memory`), category, or English id prefix. */
  readonly group: string;
  readonly id: string;
  readonly needsSetup: readonly string[];
  readonly riskLevel: RiskLevel | undefined;
  readonly script: readonly ScriptEntry[];
  readonly suite: Suite;
  readonly title: string;
}

const casesDirectory = new URL("../../docs/benchmarks/", import.meta.url);

/** Parses the Russian suite's `cases.json`. */
function parseRuSuite(text: string): BenchCase[] {
  const suite = ruSuiteSchema.parse(JSON.parse(text));
  return [
    ...suite.dimensions.map((dimension) => ({
      cleanup: dimension.cleanup,
      group: dimension.id,
      id: dimension.id,
      needsSetup: dimension.needsSetup,
      riskLevel: dimension.riskLevel,
      script: dimension.script,
      suite: "ru" as const,
      title: `${dimension.title}: ${dimension.testName}`,
    })),
    ...suite.useCases.map((useCase) => ({
      cleanup: [],
      group: useCase.category,
      id: useCase.id,
      needsSetup: useCase.needsSetup,
      riskLevel: useCase.riskLevel,
      script: [{ at: "T+0", send: useCase.prompt }],
      suite: "ru" as const,
      title: useCase.title,
    })),
  ];
}

const tsvRowSchema = z.tuple([
  z.string().regex(/^[a-z0-9_]+$/u),
  z.string().min(1),
]);

/** Parses the English suite's `id<TAB>first message` file. */
function parseEnSuite(text: string): BenchCase[] {
  return text
    .split(/\r?\n/u)
    .filter((line) => line.trim().length > 0)
    .map((line) => {
      const [id, prompt] = tsvRowSchema.parse(line.split("\t"));
      return {
        cleanup: [],
        group: id.split("_")[0] ?? id,
        id,
        needsSetup: [],
        riskLevel: undefined,
        script: [{ at: "T+0", send: prompt }],
        suite: "en" as const,
        title: id,
      };
    });
}

/** Every published case of the requested suites, in file order. */
export async function loadCases(wanted: readonly Suite[] = suites) {
  const loaded = await Promise.all(
    wanted.map(async (suite) =>
      suite === "ru"
        ? parseRuSuite(
            await readFile(new URL("ru/cases.json", casesDirectory), "utf8")
          )
        : parseEnSuite(
            await readFile(new URL("en/cases.tsv", casesDirectory), "utf8")
          )
    )
  );
  return loaded.flat();
}

/**
 * The cases a run asked for. `ids` match exactly or, ending in `*`, by
 * prefix; `groups` match a dimension id, its number (`13`), a category, or an
 * English id prefix (`d03`). Empty filters select everything.
 */
export function selectCases(
  cases: readonly BenchCase[],
  filter: {
    readonly groups: readonly string[];
    readonly ids: readonly string[];
    readonly risks: readonly RiskLevel[];
  }
) {
  const matchesId = (id: string) =>
    filter.ids.length === 0 ||
    filter.ids.some((wanted) =>
      wanted.endsWith("*") ? id.startsWith(wanted.slice(0, -1)) : id === wanted
    );
  const matchesGroup = (benchCase: BenchCase) =>
    filter.groups.length === 0 ||
    filter.groups.some((wanted) => {
      const number = /^\d+$/u.test(wanted) ? wanted.padStart(2, "0") : null;
      return number
        ? benchCase.group.startsWith(`d${number}-`)
        : benchCase.group === wanted;
    });
  const matchesRisk = (benchCase: BenchCase) =>
    filter.risks.length === 0 ||
    (benchCase.riskLevel !== undefined &&
      filter.risks.includes(benchCase.riskLevel));
  const selected = cases.filter(
    (benchCase) =>
      matchesId(benchCase.id) &&
      matchesGroup(benchCase) &&
      matchesRisk(benchCase)
  );
  const unknown = filter.ids.filter(
    (wanted) =>
      !wanted.endsWith("*") &&
      !cases.some((benchCase) => benchCase.id === wanted)
  );
  if (unknown.length > 0) {
    throw new Error(`Unknown case id: ${unknown.join(", ")}`);
  }
  return selected;
}

export function parseRiskLevels(values: readonly string[]) {
  return values.map((value) => riskLevelSchema.parse(value));
}

export function parseSuites(values: readonly string[]) {
  return values.length === 0
    ? suites
    : values.map((value) => suiteSchema.parse(value));
}

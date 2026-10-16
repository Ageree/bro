import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { z } from "zod";
import type { CaseJournal, RunRecord } from "../journal.ts";

/**
 * The bridge to the suite's Python (`docs/benchmarks/files/README.md`):
 * `fixtures.py` builds the files a case sends, `check.py` checks what Bro
 * sent back. Both run in `BENCH_PYTHON`, a venv with the sandbox pins and
 * the suite's own requirements; a failure there is journaled and never
 * changes a case's status.
 */

const runPython = promisify(execFile);
const checkScript = fileURLToPath(new URL("check.py", import.meta.url));
const fixturesScript = fileURLToPath(new URL("fixtures.py", import.meta.url));
/** The suite the checks read, as the driver does. */
const filesCasesPath = fileURLToPath(
  new URL("../../../docs/benchmarks/files/cases.json", import.meta.url)
);

const venvHint =
  "нужен Python с зависимостями набора в BENCH_PYTHON (docs/benchmarks/files/README.md, «Окружение»)";

const countSchema = z.number().int().nonnegative();

/** What `check.py --json` prints (and writes to `<out>/<case>/checks.json`). */
export const checkReportSchema = z.object({
  caseId: z.string(),
  drift: z.boolean(),
  errors: countSchema,
  failed: countSchema,
  manual: countSchema,
  passed: countSchema,
  results: z.array(
    z.object({
      description: z.string(),
      detail: z.string(),
      file: z.string().nullable(),
      /** The check's place in `cases.json`; null for an implicit one. */
      index: z.number().int().nullable(),
      kind: z.string(),
      status: z.enum(["error", "fail", "manual", "pass"]),
    })
  ),
  today: z.string(),
  tools: z.record(z.string(), z.string()),
});

export type CheckReport = z.infer<typeof checkReportSchema>;

const stderrSchema = z.object({ stderr: z.string() });

/** The end of a Python failure's stderr, where its reason is. */
function stderrTail(error: Error) {
  const stderr = stderrSchema.safeParse(error);
  const tail = stderr.success ? stderr.data.stderr.trim().slice(-600) : "";
  return tail.length > 0 ? tail : error.message;
}

/** The checks that did not pass, failures first, as the report lists them. */
export function failingChecks(report: CheckReport) {
  return [
    ...report.results.filter((result) => result.status === "fail"),
    ...report.results.filter((result) => result.status === "error"),
  ].map(
    (result) =>
      `${result.status === "fail" ? "✗" : "!"} ${result.description.length > 0 ? result.description : result.kind}`
  );
}

/**
 * Runs `check.py` over a finished (or stopped) files case and keeps its
 * totals in `driver.files.checks`. A missing Python, a crash or output that
 * does not parse leaves the checks null and says why in the journal.
 */
export async function checkFilesCase(
  record: RunRecord,
  options: {
    readonly fixturesDir: string;
    readonly journal: CaseJournal;
    readonly outDir: string;
    readonly previews: boolean;
    readonly python: string;
  }
) {
  const { journal } = options;
  const summary = record.driver.files ?? {
    checks: null,
    failedDownloads: 0,
    gates: [],
    received: 0,
  };
  let report: CheckReport;
  try {
    const { stdout } = await runPython(
      options.python,
      [
        checkScript,
        "--run",
        options.outDir,
        "--case",
        record.caseId,
        "--fixtures",
        options.fixturesDir,
        "--cases",
        filesCasesPath,
        "--json",
        ...(options.previews ? ["--previews"] : []),
      ],
      { encoding: "utf8", maxBuffer: 32 * 1024 * 1024, timeout: 15 * 60_000 }
    );
    report = checkReportSchema.parse(JSON.parse(stdout));
  } catch (error) {
    const reason =
      error instanceof Error ? stderrTail(error) : String(error).slice(0, 600);
    await journal.line(`!! проверки не прошли: ${reason}; ${venvHint}`);
    record.driver.files = { ...summary, checks: null };
    await journal.save(record);
    return { record, report: undefined };
  }
  record.driver.files = {
    ...summary,
    checks: {
      errors: report.errors,
      failed: report.failed,
      failing: failingChecks(report).slice(0, 12),
      manual: report.manual,
      passed: report.passed,
      total: report.results.length,
    },
  };
  await journal.line(
    `== проверки: ${String(report.passed)}/${String(report.results.length)} (провалов ${String(report.failed)}, ошибок ${String(report.errors)}, вручную ${String(report.manual)})${report.drift ? "; фикстуры пересобраны после прогона" : ""} → ${options.outDir}/${record.caseId}/checks.json`
  );
  await journal.save(record);
  return { record, report };
}

/**
 * Builds the fixtures of `caseIds` into `fixturesDir` with `fixtures.py`.
 * Returns why it failed, or undefined; the caller checks the files.
 */
export async function buildFilesFixtures(
  caseIds: readonly string[],
  options: { readonly fixturesDir: string; readonly python: string }
) {
  try {
    await runPython(
      options.python,
      [
        fixturesScript,
        "--case",
        caseIds.join(","),
        "--out",
        options.fixturesDir,
      ],
      { encoding: "utf8", maxBuffer: 32 * 1024 * 1024, timeout: 60 * 60_000 }
    );
    return undefined;
  } catch (error) {
    const reason =
      error instanceof Error ? stderrTail(error) : String(error).slice(0, 600);
    return `${reason}; ${venvHint}`;
  }
}

import { readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { CaseJournal, runRecordSchema, type RunRecord } from "../journal.ts";
import {
  checkFilesCase,
  checkReportSchema,
  failingChecks,
  type CheckReport,
} from "./checker.ts";

/**
 * `pnpm bench report`: the files suite's acceptance gate over one `--out`
 * directory. A case passes when it ran to its end — every turn sent, the
 * last settled `completed` — and every machine check passed (a check the
 * checker cannot answer, `manual`, never counts as passed); the judge's
 * score is the reviewer's, in the record. `--recheck` runs the checks again
 * over what the run downloaded, without a new run.
 */

const missingFileSchema = z.object({ code: z.literal("ENOENT") });

async function readChecks(outDir: string, caseId: string) {
  try {
    return checkReportSchema.parse(
      JSON.parse(await readFile(join(outDir, caseId, "checks.json"), "utf8"))
    );
  } catch (error) {
    if (missingFileSchema.safeParse(error).success) return undefined;
    throw error;
  }
}

/** The files cases' records in `outDir`, in file order; others are skipped. */
async function filesRecords(outDir: string, caseIds: readonly string[]) {
  const names = (await readdir(outDir))
    .filter((name) => name.endsWith(".json"))
    .toSorted();
  const records = await Promise.all(
    names.map(async (name) => {
      const text = await readFile(join(outDir, name), "utf8");
      try {
        const parsed = runRecordSchema.safeParse(JSON.parse(text));
        return parsed.success && parsed.data.driver.suite === "files"
          ? [parsed.data]
          : [];
      } catch {
        // Not JSON at all: not a run record either.
        return [];
      }
    })
  );
  return records
    .flat()
    .filter(
      (record) => caseIds.length === 0 || caseIds.includes(record.caseId)
    );
}

/** Each turn's latest verdict: a continued case may reach a gate again. */
function gateCounts(record: RunRecord) {
  const latest = new Map(
    (record.driver.files?.gates ?? []).map((gate) => [gate.turn, gate.met])
  );
  const verdicts = [...latest.values()];
  return {
    met: verdicts.filter(Boolean).length,
    total: verdicts.length,
  };
}

function minutesOf(record: RunRecord) {
  const end = Date.parse(record.finishedAt ?? "");
  const start = Date.parse(record.startedAt);
  return Number.isNaN(end) || Number.isNaN(start)
    ? null
    : Math.round((end - start) / 60_000);
}

function passes(record: RunRecord, report: CheckReport | undefined) {
  // A stopped case's checks pass on what it never got to: f-trap-forge
  // without its push, a timed-out task's half of the files.
  return (
    record.driver.status === "completed" &&
    record.driver.remainingSteps.length === 0 &&
    report !== undefined &&
    report.results.length > 0 &&
    report.failed === 0 &&
    report.errors === 0 &&
    report.manual === 0
  );
}

/** One case's line of the report. */
function reportRow(record: RunRecord, report: CheckReport | undefined) {
  return {
    caseId: record.caseId,
    checks:
      report === undefined
        ? null
        : {
            errors: report.errors,
            failed: report.failed,
            manual: report.manual,
            passed: report.passed,
            total: report.results.length,
          },
    drift: report?.drift ?? false,
    failing: report === undefined ? [] : failingChecks(report),
    gates: gateCounts(record),
    hints: record.hints,
    minutes: minutesOf(record),
    passes: passes(record, report),
    received: record.driver.files?.received ?? 0,
    status: record.driver.status,
  };
}

type ReportRow = ReturnType<typeof reportRow>;

export async function filesReport(options: {
  readonly caseIds: readonly string[];
  readonly fixturesDir: string;
  readonly outDir: string;
  readonly previews: boolean;
  readonly python: string;
  readonly recheck: boolean;
}) {
  const { outDir } = options;
  const records = await filesRecords(outDir, options.caseIds);
  const rows: ReportRow[] = [];
  for (const record of records) {
    let checks: CheckReport | undefined;
    if (options.recheck) {
      // A recheck that failed shows no checks, not the `checks.json` of the
      // run before it.
      // oxlint-disable-next-line eslint/no-await-in-loop -- checks run one case at a time (soffice, memory)
      ({ report: checks } = await checkFilesCase(record, {
        fixturesDir: options.fixturesDir,
        journal: new CaseJournal(outDir, record.caseId, record.timezone),
        outDir,
        previews: options.previews,
        python: options.python,
      }));
    } else {
      // oxlint-disable-next-line eslint/no-await-in-loop -- read in the order printed
      checks = await readChecks(outDir, record.caseId);
    }
    rows.push(reportRow(record, checks));
  }

  for (const row of rows) {
    const checks =
      row.checks === null
        ? "проверок нет"
        : `✓${String(row.checks.passed)} ✗${String(row.checks.failed)} err${String(row.checks.errors)} ?${String(row.checks.manual)} из ${String(row.checks.total)}`;
    console.log(
      [
        `${row.passes ? "ЗАЧЁТ" : "     "} ${row.caseId}`,
        row.status,
        checks,
        `согласие ${String(row.gates.met)}/${String(row.gates.total)}`,
        `файлов ${String(row.received)}`,
        `${row.minutes === null ? "?" : String(row.minutes)} мин`,
        `подсказок ${String(row.hints)}`,
      ].join(" | ") + (row.drift ? " | фикстуры пересобраны" : "")
    );
    for (const line of row.failing.slice(0, 3)) console.log(`    ${line}`);
  }
  const sum = (pick: (row: ReportRow) => number) =>
    rows.reduce((total, row) => total + pick(row), 0);
  const totals = {
    cases: rows.length,
    checked: rows.filter((row) => row.checks !== null).length,
    errors: sum((row) => row.checks?.errors ?? 0),
    failed: sum((row) => row.checks?.failed ?? 0),
    manual: sum((row) => row.checks?.manual ?? 0),
    passed: sum((row) => row.checks?.passed ?? 0),
    passingCases: rows.filter((row) => row.passes).length,
    total: sum((row) => row.checks?.total ?? 0),
  };
  console.log(
    `Итого: зачёт по проверкам ${String(totals.passingCases)} из ${String(totals.cases)} кейсов; проверок ${String(totals.passed)}/${String(totals.total)} (провалов ${String(totals.failed)}, ошибок ${String(totals.errors)}, вручную ${String(totals.manual)}); без проверок ${String(totals.cases - totals.checked)}`
  );
  const report = { cases: rows, totals };
  await writeFile(
    join(outDir, "files-report.json"),
    `${JSON.stringify(report, null, 2)}\n`
  );
  return report;
}

import { mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createInterface } from "node:readline/promises";
import { parseArgs } from "node:util";
import { Client, type InputRequest } from "eve/client";
import { z } from "zod";
import { benchEnv } from "../env/bench.ts";
import { ownDataTools, responseFromText } from "./approvals.ts";
import {
  loadCases,
  parseRiskLevels,
  parseSuites,
  selectCases,
  type BenchCase,
} from "./cases.ts";
import { defaultCookieFile, readCookieHeader } from "./cookies.ts";
import {
  continueCase,
  followCase,
  runCase,
  type DriverSettings,
} from "./conversation.ts";
import { readRunRecord, type RunRecord } from "./journal.ts";
import { sendSignInCode, sessionExpiry, verifySignInCode } from "./sign-in.ts";
import { parseFills, planCase } from "./steps.ts";

const usage = `Бенчмарк Бро: драйвер разговоров через eve/client.

Вход (код приходит владельцу; в журналы и файлы он не попадает):
  pnpm bench otp    [--host URL] --phone +7…
  pnpm bench verify [--host URL] --phone +7… [--code C | код в stdin] [--cookie-file PATH]

Прогон:
  pnpm bench list   [--suite ru|en] [--case id,…] [--group d13|13|категория] [--risk read-only]
  pnpm bench run    [отбор как у list] [--host URL] [--cookie-file PATH] [--out DIR]
                    [--fill '[ресторан]=Хачапури и вино'] [--attach FILE] [--voice FILE]
                    [--approve tool] [--concurrency 4] [--max-steps N]
                    [--background-wait-min 20] [--nudges 1] [--turn-timeout-min 15]
                    [--dry-run]
  pnpm bench send   --out DIR --case ID (--text T | --code C | --option ID)
                    [--kind hint|answer|approval|code] [--attach FILE] [--voice FILE]
  pnpm bench follow --out DIR --case ID [--background-wait-min 20]

По умолчанию хост https://brobro.tech, cookie ~/.bro-bench/cookies.txt.
Журналы: <out>/<case>.events.jsonl, <case>.log, <case>.json (запись прогона).
Правила ответов на карточки и подсказок — docs/benchmarks/README.md.`;

const options = {
  approve: { multiple: true, type: "string" },
  attach: { multiple: true, type: "string" },
  "background-wait-min": { type: "string" },
  case: { multiple: true, type: "string" },
  code: { type: "string" },
  concurrency: { type: "string" },
  "cookie-file": { type: "string" },
  "dry-run": { type: "boolean" },
  "max-steps": { type: "string" },
  fill: { multiple: true, type: "string" },
  group: { multiple: true, type: "string" },
  help: { short: "h", type: "boolean" },
  hint: { type: "string" },
  host: { type: "string" },
  kind: { type: "string" },
  nudges: { type: "string" },
  option: { type: "string" },
  out: { type: "string" },
  phone: { type: "string" },
  risk: { multiple: true, type: "string" },
  suite: { multiple: true, type: "string" },
  text: { type: "string" },
  "turn-timeout-min": { type: "string" },
  voice: { multiple: true, type: "string" },
} as const;

const { positionals, values } = parseArgs({
  allowPositionals: true,
  args: process.argv.slice(2),
  options,
  strict: true,
});

type Values = typeof values;

const list = (items: readonly string[] | undefined) =>
  (items ?? []).flatMap((item) =>
    item
      .split(",")
      .map((part) => part.trim())
      .filter((part) => part.length > 0)
  );

const minutesSchema = z.coerce.number().nonnegative();
const countSchema = z.coerce.number().int().nonnegative();
const turnKindSchema = z.enum(["hint", "answer", "approval", "code"]);

function minutes(value: string | undefined, fallback: number) {
  return Math.round(minutesSchema.parse(value ?? fallback) * 60_000);
}

async function selected(flags: Values) {
  const cases = await loadCases(parseSuites(list(flags.suite)));
  return selectCases(cases, {
    groups: list(flags.group),
    ids: list(flags.case),
    risks: parseRiskLevels(list(flags.risk)),
  });
}

const targetHost = (flags: Values, recordedHost?: string) =>
  new URL(flags.host ?? recordedHost ?? benchEnv.BENCH_HOST);

const cookieFile = (flags: Values) =>
  resolve(
    flags["cookie-file"] ?? benchEnv.BENCH_COOKIE_FILE ?? defaultCookieFile
  );

/** A client signed in as the tester, checked before the first message. */
async function connection(flags: Values, recordedHost?: string) {
  const host = targetHost(flags, recordedHost);
  const cookie = await readCookieHeader(cookieFile(flags), host);
  const expires = await sessionExpiry(host, cookie);
  console.log(`${host.origin}: сессия до ${expires.toISOString()}`);
  const client = new Client({
    headers: { cookie, origin: host.origin },
    host: host.origin,
    // A redirect here is the sign-in page; never follow it with the cookie.
    redirect: "manual",
  });
  await client.health();
  return { client, host: host.origin };
}

function settings(flags: Values, host: string, outDir: string): DriverSettings {
  return {
    approvedTools: [...ownDataTools, ...list(flags.approve)],
    backgroundWaitMs: minutes(flags["background-wait-min"], 20),
    extraFiles: list(flags.attach).map((path) => ({ path: resolve(path) })),
    hintText: flags.hint ?? "ну что там?",
    host,
    nudges: countSchema.parse(flags.nudges ?? 1),
    outDir,
    tester: benchEnv.BENCH_TESTER,
    timeZone: benchEnv.BENCH_TIMEZONE,
    turnTimeoutMs: minutes(flags["turn-timeout-min"], 15),
    voice: list(flags.voice).map((path) => resolve(path)),
  };
}

function summaryLine(record: RunRecord) {
  const { driver } = record;
  const detail = driver.statusDetail ? ` — ${driver.statusDetail}` : "";
  return `${record.caseId}: ${driver.status}${detail} (подсказок ${String(record.hints)}, карточек ${String(driver.decisions.length)}) → ${record.transcript}`;
}

async function listCommand(flags: Values) {
  const fills = parseFills(list(flags.fill));
  for (const benchCase of await selected(flags)) {
    const plan = planCase(benchCase, fills);
    const state =
      plan.kind === "ready"
        ? `${String(plan.steps.length)} сообщ.`
        : `пропуск: ${plan.reason}`;
    const setup =
      benchCase.needsSetup.length > 0
        ? ` | нужно: ${benchCase.needsSetup.join("; ")}`
        : "";
    console.log(
      `${benchCase.id}\t${benchCase.riskLevel ?? "—"}\t${state}\t${benchCase.title}${setup}`
    );
  }
}

async function pool(
  items: readonly BenchCase[],
  limit: number,
  work: (item: BenchCase) => Promise<void>
) {
  let next = 0;
  const worker = async () => {
    for (;;) {
      const item = items[next];
      next += 1;
      if (!item) return;
      // oxlint-disable-next-line eslint/no-await-in-loop -- each worker runs its cases one after another; the pool bounds parallel conversations
      await work(item);
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, () => worker())
  );
}

async function runCommand(flags: Values) {
  const fills = parseFills(list(flags.fill));
  const cases = await selected(flags);
  const plans = cases.map((benchCase) => ({
    benchCase,
    plan: planCase(benchCase, fills),
  }));
  for (const { benchCase, plan } of plans) {
    if (plan.kind === "skipped") {
      console.log(`${benchCase.id}: пропущен — ${plan.reason}`);
    }
  }
  const ready = plans.flatMap(({ benchCase, plan }) =>
    plan.kind === "ready" ? [{ benchCase, plan }] : []
  );
  if (flags["dry-run"]) {
    for (const { benchCase, plan } of ready) {
      console.log(`${benchCase.id}:`);
      for (const step of plan.steps) {
        const files = step.files.map((file) => file.path).join(", ");
        console.log(
          `  [${step.at}]${step.newConversation ? " (новый разговор)" : ""} ${step.text}${files ? ` + ${files}` : ""}`
        );
      }
    }
    return;
  }
  if (ready.length === 0) throw new Error("No case to run.");

  const maxSteps = flags["max-steps"]
    ? countSchema.min(1).parse(flags["max-steps"])
    : Number.POSITIVE_INFINITY;
  const concurrency = countSchema.parse(flags.concurrency ?? 4);
  if (concurrency < 1) throw new Error("--concurrency must be at least 1.");
  if (concurrency > 4) {
    console.warn(
      "Больше четырёх разговоров сразу: Browser Use отвечает 429 с пяти параллельных сессий."
    );
  }
  const { client, host } = await connection(flags);
  const stamp = new Date().toISOString().replaceAll(/[:.]/gu, "-").slice(0, 19);
  const outDir = resolve(
    flags.out ??
      benchEnv.BENCH_OUT_DIR ??
      join(tmpdir(), "bro-bench", "runs", stamp)
  );
  await mkdir(outDir, { recursive: true });
  console.log(`Журналы: ${outDir}`);
  const driverSettings = settings(flags, host, outDir);
  const plansById = new Map(
    ready.map(({ benchCase, plan }) => [benchCase.id, plan])
  );
  const records: RunRecord[] = [];
  await pool(
    ready.map(({ benchCase }) => benchCase),
    concurrency,
    async (benchCase) => {
      const plan = plansById.get(benchCase.id);
      if (plan?.kind !== "ready") return;
      console.log(`${benchCase.id}: старт`);
      const record = await runCase(
        client,
        benchCase,
        maxSteps < plan.steps.length
          ? plan.steps.slice(0, maxSteps)
          : plan.steps,
        maxSteps < plan.steps.length
          ? [
              ...plan.notes,
              `драйвер отправил ${String(maxSteps)} из ${String(plan.steps.length)} сообщений (--max-steps)`,
            ]
          : plan.notes,
        driverSettings
      );
      records.push(record);
      console.log(summaryLine(record));
    }
  );
  await writeFile(
    join(outDir, "summary.json"),
    `${JSON.stringify(
      records.map((record) => ({
        caseId: record.caseId,
        hints: record.hints,
        record: join(outDir, `${record.caseId}.json`),
        status: record.driver.status,
        statusDetail: record.driver.statusDetail,
      })),
      null,
      2
    )}\n`
  );
  if (records.some((record) => record.driver.status === "failed")) {
    process.exitCode = 1;
  }
}

function recordLocation(flags: Values) {
  const outDir = flags.out ?? benchEnv.BENCH_OUT_DIR;
  const [caseId, ...extra] = list(flags.case);
  if (!outDir || !caseId || extra.length > 0) {
    throw new Error("Name one run: --out DIR --case ID.");
  }
  return { caseId, outDir: resolve(outDir) };
}

async function sendCommand(flags: Values) {
  const { caseId, outDir } = recordLocation(flags);
  const record = await readRunRecord(outDir, caseId);
  const given = [flags.text, flags.code, flags.option].filter(
    (value) => value !== undefined
  );
  if (given.length !== 1) {
    throw new Error("Pass exactly one of --text, --code or --option.");
  }
  const text = flags.text ?? flags.code ?? flags.option ?? "";
  const kind = turnKindSchema.parse(
    flags.kind ??
      (flags.code === undefined
        ? flags.option === undefined
          ? "hint"
          : "approval"
        : "code")
  );
  const { client, host } = await connection(flags, record.driver.host);
  const respond = (pending: readonly InputRequest[]) => {
    const [request, ...others] = pending;
    if (!request) {
      if (flags.option !== undefined) {
        throw new Error("There is no pending card to answer with --option.");
      }
      return undefined;
    }
    if (others.length > 0 && flags.option === undefined) {
      throw new Error(
        "Several cards are pending; answer them with --option, which applies to each."
      );
    }
    return pending.map((each) => responseFromText(each, text));
  };
  const updated = await continueCase(
    client,
    record,
    settings(flags, host, outDir),
    { code: flags.code, kind, respond, text }
  );
  console.log(summaryLine(updated));
}

async function followCommand(flags: Values) {
  const { caseId, outDir } = recordLocation(flags);
  const record = await readRunRecord(outDir, caseId);
  const { client, host } = await connection(flags, record.driver.host);
  const updated = await followCase(
    client,
    record,
    settings(flags, host, outDir)
  );
  console.log(summaryLine(updated));
}

function phoneNumber(flags: Values) {
  const phone = flags.phone ?? benchEnv.BENCH_PHONE;
  if (!phone) throw new Error("Pass --phone +7… (or set BENCH_PHONE).");
  return phone;
}

async function otpCommand(flags: Values) {
  await sendSignInCode(targetHost(flags), phoneNumber(flags));
  console.log(
    "Код отправлен. Дальше: pnpm bench verify --phone … --code <код> (или код в stdin)."
  );
}

/** Reads the code from stdin: a prompt in a terminal, one line when piped. */
async function codeFromInput() {
  const prompt = createInterface({
    input: process.stdin,
    output: process.stdin.isTTY ? process.stdout : undefined,
  });
  try {
    return (await prompt.question("Код входа: ")).trim();
  } finally {
    prompt.close();
  }
}

async function verifyCommand(flags: Values) {
  const host = targetHost(flags);
  const code = flags.code ?? (await codeFromInput());
  if (!/^\d{4,8}$/u.test(code)) throw new Error("The code is 4 to 8 digits.");
  const file = cookieFile(flags);
  await verifySignInCode(host, phoneNumber(flags), code, file);
  const expires = await sessionExpiry(host, await readCookieHeader(file, host));
  console.log(
    `Сессия сохранена в ${file} (права 600), действует до ${expires.toISOString()}.`
  );
}

const commands = {
  follow: followCommand,
  list: listCommand,
  otp: otpCommand,
  run: runCommand,
  send: sendCommand,
  verify: verifyCommand,
} as const;

const commandSchema = z.enum([
  "follow",
  "list",
  "otp",
  "run",
  "send",
  "verify",
]);

const [commandName, ...extraPositionals] = positionals;

if (values.help || commandName === undefined) {
  console.log(usage);
} else {
  const command = commandSchema.safeParse(commandName);
  // A stray word is refused, not ignored: `pnpm bench run typo` would
  // otherwise run every case against production.
  if (!command.success || extraPositionals.length > 0) {
    console.error(
      command.success
        ? `Лишние аргументы: ${extraPositionals.join(" ")}. Кейсы выбираются флагами --case, --group, --suite, --risk.\n`
        : `Нет такой команды: ${commandName}.\n`
    );
    console.error(usage);
    process.exitCode = 2;
  } else {
    await commands[command.data](values);
  }
}

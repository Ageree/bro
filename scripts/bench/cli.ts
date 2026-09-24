import { mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createInterface } from "node:readline/promises";
import { parseArgs } from "node:util";
import { Client, type InputRequest } from "eve/client";
import { z } from "zod";
import { benchEnv } from "../env/bench.ts";
import { caseFixtureSets } from "./account/catalog.ts";
import { composioProxy, findGoogleAccount } from "./account/composio.ts";
import { googleAccount } from "./account/google.ts";
import { defaultManifestFile, readManifest } from "./account/manifest.ts";
import {
  caseFixtureState,
  cleanFixtures,
  describeFixtures,
  planFixtures,
  seedFixtures,
} from "./account/seed.ts";
import { ownDataTools, responseFromText } from "./approvals.ts";
import {
  loadCases,
  parseRiskLevels,
  parseSuites,
  selectCases,
  type BenchCase,
} from "./cases.ts";
import { parseLocalMoment } from "./clock.ts";
import { defaultCookieFile, readCookieHeader } from "./cookies.ts";
import {
  continueCase,
  followCase,
  nextCase,
  noteObservation,
  observeCase,
  runCase,
  type DriverSettings,
} from "./conversation.ts";
import { readRunRecord, type RunRecord } from "./journal.ts";
import {
  sendSignInCode,
  signedInSession,
  verifySignInCode,
} from "./sign-in.ts";
import { parseFills, planCase } from "./steps.ts";

const usage = `Бенчмарк Бро: драйвер разговоров через eve/client.

Вход (код приходит владельцу; в журналы и файлы он не попадает):
  pnpm bench otp    [--host URL] --phone +7…
  pnpm bench verify [--host URL] --phone +7… [--code C | код в stdin] [--cookie-file PATH]

Заготовки в Google-аккаунте тестировщика (письма, события, файл в Диске):
  pnpm bench fixtures list  [отбор как у list]
  pnpm bench fixtures seed  --case ID,… [--dry-run [--mailbox ADDR]] [--track N]
                            [--spread-min 150] [--user-id ID | --account ca_…]
  pnpm bench fixtures clean [--case ID,…] [--dry-run]
                            (без --case убирает всё засеянное)

Прогон:
  pnpm bench list   [--suite ru|en] [--case id,…] [--group d13|13|категория] [--risk read-only]
  pnpm bench run    [отбор как у list] [--host URL] [--cookie-file PATH] [--out DIR]
                    [--fill '[ресторан]=Хачапури и вино'] [--attach FILE] [--voice FILE]
                    [--approve tool] [--concurrency 4] [--max-steps N] [--compress]
                    [--background-wait-min 20] [--nudges 1] [--turn-timeout-min 15]
                    [--dry-run]
                    (шаг сценария «T+7д» ждёт своего срока: pnpm bench next;
                    --compress шлёт все шаги сразу)
  pnpm bench next   --out DIR --case ID [--early]
                    (следующие шаги сценария, когда подошёл их срок)
  pnpm bench send   --out DIR --case ID (--text T | --code C | --option ID)
                    [--kind hint|answer|approval|code|probe|cleanup] [--attach FILE] [--voice FILE]
                    (--kind answer отвечает на вопрос, на котором кейс встал,
                    и досылает оставшиеся сообщения сценария)
  pnpm bench send   --out DIR --case ID --kind observed --text T
                    [--channel telegram|imessage|web] [--at 06:40]
                    (ничего не отправляет: записывает, что Бро написал сам в мессенджер)
  pnpm bench observe --out DIR --case ID [--session ID] [--minutes 60] [--since 21:00]
                    (смотрит разговор и записывает, что Бро пишет сам; ничего не шлёт)
  pnpm bench follow --out DIR --case ID [--background-wait-min 20]

По умолчанию хост https://brobro.tech, cookie ~/.bro-bench/cookies.txt,
заготовки ~/.bro-bench/fixtures.json.
Журналы: <out>/<case>.events.jsonl, <case>.log, <case>.json (запись прогона).
Правила ответов на карточки и подсказок — docs/benchmarks/README.md.`;

const options = {
  account: { type: "string" },
  approve: { multiple: true, type: "string" },
  at: { type: "string" },
  attach: { multiple: true, type: "string" },
  "background-wait-min": { type: "string" },
  case: { multiple: true, type: "string" },
  channel: { type: "string" },
  code: { type: "string" },
  compress: { type: "boolean" },
  concurrency: { type: "string" },
  "cookie-file": { type: "string" },
  "dry-run": { type: "boolean" },
  early: { type: "boolean" },
  "max-steps": { type: "string" },
  fill: { multiple: true, type: "string" },
  group: { multiple: true, type: "string" },
  help: { short: "h", type: "boolean" },
  hint: { type: "string" },
  host: { type: "string" },
  kind: { type: "string" },
  mailbox: { type: "string" },
  minutes: { type: "string" },
  nudges: { type: "string" },
  option: { type: "string" },
  out: { type: "string" },
  phone: { type: "string" },
  risk: { multiple: true, type: "string" },
  session: { type: "string" },
  since: { type: "string" },
  "spread-min": { type: "string" },
  suite: { multiple: true, type: "string" },
  text: { type: "string" },
  track: { type: "string" },
  "turn-timeout-min": { type: "string" },
  "user-id": { type: "string" },
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
const sendKindSchema = z.enum([
  "answer",
  "approval",
  "cleanup",
  "code",
  "hint",
  "observed",
  "probe",
]);
const channelSchema = z.enum(["imessage", "telegram", "web"]);
// A СДЭК track is ten digits; the tester's own parcel makes d11 checkable.
const trackSchema = z.string().regex(/^\d{10,14}$/u, "--track is 10–14 digits");
const defaultTrack = "1094857362";

function minutes(value: string | undefined, fallback: number) {
  return Math.round(minutesSchema.parse(value ?? fallback) * 60_000);
}

const chosenCases = (flags: Values) =>
  [flags.case, flags.group, flags.suite, flags.risk].some(
    (items) => list(items).length > 0
  );

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
  const { expiresAt } = await signedInSession(host, cookie);
  console.log(`${host.origin}: сессия до ${expiresAt.toISOString()}`);
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
    paced: flags.compress !== true,
    tester: benchEnv.BENCH_TESTER,
    timeZone: benchEnv.BENCH_TIMEZONE,
    turnTimeoutMs: minutes(flags["turn-timeout-min"], 15),
    voice: list(flags.voice).map((path) => resolve(path)),
  };
}

function summaryLine(record: RunRecord) {
  const { driver } = record;
  const detail = driver.statusDetail ? ` — ${driver.statusDetail}` : "";
  const observed =
    driver.observations.length > 0
      ? `, наблюдений ${String(driver.observations.length)}`
      : "";
  return `${record.caseId}: ${driver.status}${detail} (подсказок ${String(record.hints)}, карточек ${String(driver.decisions.length)}${observed}) → ${record.transcript}`;
}

/** The script as the record's notes: what the tester does and when. */
const scriptNotes = (benchCase: BenchCase) =>
  benchCase.script.map(
    (entry) => `${entry.at}: ${entry.send ?? entry.note ?? "без сообщения"}`
  );

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
    const sets = caseFixtureSets.get(benchCase.id);
    const fixtures = sets ? ` | заготовки: ${sets.join(", ")}` : "";
    console.log(
      `${benchCase.id}\t${benchCase.riskLevel ?? "—"}\t${state}\t${benchCase.title}${setup}${fixtures}`
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

  // What the account was seeded with goes into each record for the
  // reviewer; a case run without its letters is flagged before it starts.
  const manifest = await readManifest(defaultManifestFile);
  const fixtureNotes = new Map(
    ready.map(({ benchCase }) => {
      const state = caseFixtureState(manifest, benchCase.id);
      if (state.missing.length > 0) {
        console.warn(
          `${benchCase.id}: не засеяны заготовки ${state.missing.join(", ")} — pnpm bench fixtures seed --case ${benchCase.id}`
        );
      }
      return [benchCase.id, state.notes] as const;
    })
  );

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
        [
          ...plan.notes,
          ...(fixtureNotes.get(benchCase.id) ?? []),
          ...(maxSteps < plan.steps.length
            ? [
                `драйвер отправил ${String(maxSteps)} из ${String(plan.steps.length)} сообщений (--max-steps)`,
              ]
            : []),
        ],
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

async function oneCase(caseId: string) {
  const [benchCase] = selectCases(await loadCases(), {
    groups: [],
    ids: [caseId],
    risks: [],
  });
  if (!benchCase) throw new Error(`Unknown case id: ${caseId}`);
  return benchCase;
}

const missingFileSchema = z.object({ code: z.literal("ENOENT") });

/** The case's record in `outDir`, or nothing for a case not started there. */
async function existingRecord(outDir: string, caseId: string) {
  try {
    return await readRunRecord(outDir, caseId);
  } catch (error) {
    if (missingFileSchema.safeParse(error).success) return undefined;
    throw error;
  }
}

/** `send --kind observed`: a message Bro wrote in a messenger, pasted in. */
async function recordObservedCommand(flags: Values) {
  const { caseId, outDir } = recordLocation(flags);
  if (flags.text === undefined) {
    throw new Error(
      "Paste what arrived with --text; --kind observed sends nothing."
    );
  }
  const benchCase = await oneCase(caseId);
  const existing = await existingRecord(outDir, caseId);
  const timeZone = benchEnv.BENCH_TIMEZONE;
  const host = targetHost(flags, existing?.driver.host).origin;
  const record = await noteObservation(
    benchCase,
    existing,
    settings(flags, host, outDir),
    {
      at: flags.at
        ? parseLocalMoment(flags.at, new Date(), timeZone)
        : new Date(),
      channel: channelSchema.parse(flags.channel ?? "telegram"),
      notes: scriptNotes(benchCase),
      text: flags.text,
    }
  );
  console.log(summaryLine(record));
}

async function sendCommand(flags: Values) {
  const kind = sendKindSchema.parse(
    flags.kind ??
      (flags.code === undefined
        ? flags.option === undefined
          ? "hint"
          : "approval"
        : "code")
  );
  if (kind === "observed") {
    await recordObservedCommand(flags);
    return;
  }
  const { caseId, outDir } = recordLocation(flags);
  const record = await readRunRecord(outDir, caseId);
  const given = [flags.text, flags.code, flags.option].filter(
    (value) => value !== undefined
  );
  if (given.length !== 1) {
    throw new Error("Pass exactly one of --text, --code or --option.");
  }
  const text = flags.text ?? flags.code ?? flags.option ?? "";
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

async function nextCommand(flags: Values) {
  const { caseId, outDir } = recordLocation(flags);
  const record = await readRunRecord(outDir, caseId);
  const { client, host } = await connection(flags, record.driver.host);
  const updated = await nextCase(
    client,
    record,
    settings(flags, host, outDir),
    { early: flags.early === true }
  );
  console.log(summaryLine(updated));
}

async function observeCommand(flags: Values) {
  const { caseId, outDir } = recordLocation(flags);
  const benchCase = await oneCase(caseId);
  const existing = await existingRecord(outDir, caseId);
  const timeZone = benchEnv.BENCH_TIMEZONE;
  const fixtures = caseFixtureState(
    await readManifest(defaultManifestFile),
    caseId
  );
  const { client, host } = await connection(flags, existing?.driver.host);
  await mkdir(outDir, { recursive: true });
  const record = await observeCase(
    client,
    benchCase,
    existing,
    settings(flags, host, outDir),
    {
      channel: channelSchema.parse(flags.channel ?? "web"),
      durationMs: minutes(flags.minutes, 60),
      notes: [...scriptNotes(benchCase), ...fixtures.notes],
      sessionId: flags.session,
      // A conversation never read before is read from when its case's
      // fixtures went in: what Bro wrote about them before the watch began
      // counts too.
      since: flags.since
        ? parseLocalMoment(flags.since, new Date(), timeZone)
        : (fixtures.seededAt ?? new Date()),
    }
  );
  for (const observation of record.driver.observations) {
    console.log(
      `  ${observation.at}${observation.night ? " (ночь)" : ""} ${observation.channel}: ${observation.text.slice(0, 160)}`
    );
  }
  console.log(summaryLine(record));
}

function composioKey() {
  const key = benchEnv.COMPOSIO_API_KEY;
  if (!key) throw new Error("Set COMPOSIO_API_KEY (Composio project API key).");
  return key;
}

/** The Bro user the tester signed in as, whose Google connection is used. */
async function broUserId(flags: Values) {
  if (flags["user-id"]) return flags["user-id"];
  const host = targetHost(flags);
  const cookie = await readCookieHeader(cookieFile(flags), host);
  return (await signedInSession(host, cookie)).userId;
}

async function fixturesListCommand(flags: Values) {
  const manifest = await readManifest(defaultManifestFile);
  const cases = (await selected(flags)).filter((benchCase) =>
    caseFixtureSets.has(benchCase.id)
  );
  for (const benchCase of cases) {
    const sets = caseFixtureSets.get(benchCase.id) ?? [];
    console.log(`${benchCase.id}\t${sets.join(", ")}\t${benchCase.title}`);
    for (const set of sets) {
      const entries = manifest.sets.filter((entry) => entry.set === set);
      if (entries.length === 0) console.log(`  ${set}: не засеяно`);
      for (const entry of entries) {
        const items = manifest.items.filter(
          (item) =>
            item.account === entry.account && item.key.startsWith(`${set}/`)
        ).length;
        console.log(
          `  ${set}: ${entry.complete ? "засеяно" : "засев не закончен"} ${entry.seededAt} в ${entry.mailbox} (${entry.account}), объектов ${String(items)}`
        );
        for (const line of entry.expect) console.log(`    проверить: ${line}`);
      }
    }
  }
}

async function fixturesSeedCommand(flags: Values) {
  if (!chosenCases(flags)) {
    throw new Error(
      "Choose the cases to seed: --case d09-email,… (or --group / --suite)."
    );
  }
  const caseIds = (await selected(flags))
    .map((benchCase) => benchCase.id)
    .filter((caseId) => caseFixtureSets.has(caseId));
  if (caseIds.length === 0) {
    throw new Error(
      "None of the chosen cases needs fixtures: pnpm bench fixtures list."
    );
  }
  const timeZone = benchEnv.BENCH_TIMEZONE;
  const track = trackSchema.parse(flags.track ?? defaultTrack);
  const now = new Date();
  if (flags["dry-run"]) {
    const context = {
      mailbox: flags.mailbox ?? "tester@example.com",
      now,
      timeZone,
      track,
    };
    console.log(
      `Засев (пробный, Google не трогается), ящик ${context.mailbox}, пояс ${timeZone}:`
    );
    for (const line of describeFixtures(
      planFixtures(caseIds, context),
      timeZone
    )) {
      console.log(line);
    }
    return;
  }
  const apiKey = composioKey();
  const account =
    flags.account ?? (await findGoogleAccount(apiKey, await broUserId(flags)));
  const google = googleAccount(composioProxy(apiKey, account));
  const mailbox = await google.mailbox();
  console.log(`Засев в ${mailbox} (Composio ${account}), пояс ${timeZone}`);
  const context = { mailbox, now, timeZone, track };
  const plan = planFixtures(caseIds, context);
  await seedFixtures({
    account,
    context,
    google,
    log: (line) => {
      console.log(line);
    },
    manifestPath: defaultManifestFile,
    plan,
    spreadMs: minutes(flags["spread-min"], 0),
  });
  // What was actually seeded: a set seeded earlier keeps that seed's dates.
  const manifest = await readManifest(defaultManifestFile);
  for (const set of plan) {
    const entry = manifest.sets.find(
      (known) => known.account === account && known.set === set.id
    );
    for (const line of entry?.expect ?? []) {
      console.log(`${set.id}: проверить — ${line}`);
    }
  }
  console.log(`Убрать: pnpm bench fixtures clean --case ${caseIds.join(",")}`);
}

async function fixturesCleanCommand(flags: Values) {
  const dryRun = flags["dry-run"] === true;
  const apiKey = dryRun ? "" : composioKey();
  await cleanFixtures({
    caseIds: chosenCases(flags)
      ? (await selected(flags)).map((benchCase) => benchCase.id)
      : undefined,
    dryRun,
    google: (account) => googleAccount(composioProxy(apiKey, account)),
    log: (line) => {
      console.log(line);
    },
    manifestPath: defaultManifestFile,
  });
}

const fixturesCommands = {
  clean: fixturesCleanCommand,
  list: fixturesListCommand,
  seed: fixturesSeedCommand,
} as const;

const fixturesActionSchema = z.enum(["clean", "list", "seed"]);

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
  const { expiresAt } = await signedInSession(
    host,
    await readCookieHeader(file, host)
  );
  console.log(
    `Сессия сохранена в ${file} (права 600), действует до ${expiresAt.toISOString()}.`
  );
}

const commands = {
  follow: followCommand,
  list: listCommand,
  next: nextCommand,
  observe: observeCommand,
  otp: otpCommand,
  run: runCommand,
  send: sendCommand,
  verify: verifyCommand,
} as const;

const commandSchema = z.enum([
  "fixtures",
  "follow",
  "list",
  "next",
  "observe",
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
  const [action, ...stray] =
    command.data === "fixtures"
      ? extraPositionals
      : [undefined, ...extraPositionals];
  const fixturesAction =
    command.data === "fixtures"
      ? fixturesActionSchema.safeParse(action)
      : undefined;
  // A stray word is refused, not ignored: `pnpm bench run typo` would
  // otherwise run every case against production.
  if (!command.success) {
    console.error(`Нет такой команды: ${commandName}.\n`);
    console.error(usage);
    process.exitCode = 2;
  } else if (fixturesAction?.success === false) {
    console.error(
      `После fixtures нужно seed, clean или list, а не ${action ?? "ничего"}.\n`
    );
    console.error(usage);
    process.exitCode = 2;
  } else if (stray.length > 0) {
    console.error(
      `Лишние аргументы: ${stray.join(" ")}. Кейсы выбираются флагами --case, --group, --suite, --risk.\n`
    );
    console.error(usage);
    process.exitCode = 2;
  } else if (fixturesAction?.success) {
    await fixturesCommands[fixturesAction.data](values);
  } else if (command.data !== "fixtures") {
    await commands[command.data](values);
  }
}

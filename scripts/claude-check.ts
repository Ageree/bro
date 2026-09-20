import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import { assert, src, srcJson } from "./lib/check.ts";

/**
 * Держит в рабочем виде память облачных агентов — `CLAUDE.md`,
 * `.claude/memory/` и SessionStart-хук.
 *
 * Ломается она тихо. Переименованный файл темы, съехавший `@`-импорт,
 * разросшийся за 200 строк индекс (всё сверх лимита Claude Code просто не
 * грузит) — ничего из этого не падает и не краснеет: следующая облачная
 * сессия молча стартует без половины памяти, и понять это можно только по
 * тому, что агент снова не знает вещей, которые уже знал. Поэтому границы
 * проверяются здесь, вместе с остальной батареей.
 */

const ROOT = fileURLToPath(new URL("../", import.meta.url));
const INDEX = ".claude/memory/MEMORY.md";

// --- CLAUDE.md: существует, влезает в лимит, тянет индекс памяти ---

const claudeMd = src("CLAUDE.md");
const claudeMdLines = claudeMd.split("\n").length;
assert(
  claudeMdLines <= 200,
  `CLAUDE.md is ${claudeMdLines} lines; Claude Code guidance caps it at 200 for adherence`,
);
assert(
  claudeMd.includes(`@${INDEX}`),
  `CLAUDE.md must import the memory index as @${INDEX} — without it nothing loads the memory`,
);

// `@README.md` утянул бы 30 КБ в каждую сессию: ссылка на него намеренно
// в обратных кавычках, и это легко потерять при первой же правке.
assert(
  !/^[^`]*@README\.md/mu.test(claudeMd),
  "CLAUDE.md must not @-import README.md: it is ~30KB of context on every session",
);

// --- индекс памяти: лимиты загрузки и живые ссылки на темы ---

const index = src(INDEX);
const indexLines = index.split("\n").length;
assert(
  indexLines <= 200,
  `${INDEX} is ${indexLines} lines; only the first 200 are loaded at session start`,
);
assert(
  Buffer.byteLength(index, "utf8") <= 25_000,
  `${INDEX} is over the 25KB that Claude Code loads at session start`,
);

// Тема упомянута в индексе — файл обязан существовать, иначе ссылка ведёт в
// пустоту ровно в тот момент, когда по ней пошли.
const topics = [...index.matchAll(/^- `([\w.-]+\.md)`/gmu)].map((m) => m[1]);
assert(topics.length > 0, `${INDEX} lists no topic files — the "## Темы" section is empty or reshaped`);
for (const topic of topics) {
  let body = "";
  try {
    body = src(`.claude/memory/${topic}`);
  } catch {
    body = "";
  }
  assert(
    body.trim().length > 0,
    `${INDEX} points at .claude/memory/${topic}, which is missing or empty`,
  );
}

// --- settings.json: хук объявлен и указывает на существующий файл ---

type Settings = {
  hooks?: {
    SessionStart?: { matcher?: string; hooks?: { type?: string; command?: string }[] }[];
  };
};

const settings = srcJson<Settings>(".claude/settings.json");
const entries = settings.hooks?.SessionStart ?? [];
assert(entries.length > 0, ".claude/settings.json declares no SessionStart hook");

const commands = entries.flatMap((e) => (e.hooks ?? []).map((h) => h.command ?? ""));
const hookCommand = commands.find((c) => c.includes(".claude/hooks/session-start.ts"));
assert(
  hookCommand !== undefined,
  "SessionStart hook must run .claude/hooks/session-start.ts",
);
assert(
  hookCommand.includes("${CLAUDE_PROJECT_DIR}"),
  "SessionStart command must resolve through ${CLAUDE_PROJECT_DIR}: the hook's cwd is not guaranteed",
);
assert(
  entries.some((e) => (e.matcher ?? "").includes("startup")),
  'SessionStart hook must match "startup", or a fresh cloud session gets nothing',
);

// --- хук реально запускается и печатает справку ---

// Он читает git и диск, ничего не пишет и не ходит в сеть, так что гонять
// его целиком здесь дешевле, чем узнать о падении на старте сессии.
let output: string;
try {
  output = execFileSync(
    process.execPath,
    ["--experimental-strip-types", ".claude/hooks/session-start.ts"],
    { cwd: ROOT, encoding: "utf8", timeout: 15_000, env: { ...process.env, CLAUDE_PROJECT_DIR: ROOT } },
  );
} catch (err) {
  throw new Error(
    `.claude/hooks/session-start.ts failed to run: ${err instanceof Error ? err.message : String(err)}`,
  );
}

assert(
  output.includes("## Состояние репозитория"),
  "session-start hook printed no report header — its stdout is what reaches the session",
);
assert(
  output.includes(".harness/goals"),
  "session-start hook must surface .harness/goals: that is the link between memory and the long-running goals",
);

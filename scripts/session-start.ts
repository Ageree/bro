// Состояние репозитория на старте сессии.
//
// `CLAUDE.md` тянет `AGENTS.md` и индекс памяти — это то, что верно всегда.
// Здесь противоположное: то, что протухает с каждым коммитом и потому не
// может лежать в файле. Ветка, незакоммиченное, последние коммиты.
//
// stdout хука Claude Code добавляет в контекст сессии (`SessionStart` — одно
// из немногих событий, где так), значит каждая строка стоит токенов в каждой
// сессии: вывод намеренно узкий и усечённый.
//
// Падать хук не имеет права — сломанный старт сессии дороже отсутствующей
// справки, — поэтому всё обёрнуто и выход всегда нулевой.
//
// Живёт в `scripts/`, а не в `.claude/`: TypeScript пропускает каталоги с
// точкой, поэтому там файл остался бы без типов и без type-aware линта.
// `.claude/settings.json` вызывает его отсюда.
import { execFileSync } from "node:child_process";

// oxlint-disable-next-line eslint/no-restricted-properties -- the hook runs before the application, outside any validated environment
const environment = { ...process.env };
const root = environment.CLAUDE_PROJECT_DIR ?? process.cwd();
const commitCount = 6;
const dirtyLimit = 10;
const width = 110;

function git(...args: string[]): string {
  return execFileSync("git", args, {
    cwd: root,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
    timeout: 5000,
  }).trim();
}

function clip(text: string, max: number = width): string {
  const flat = text.replaceAll(/\s+/gu, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

function section(title: string, lines: string[]): string[] {
  return lines.length ? ["", title, ...lines.map((line) => `- ${line}`)] : [];
}

function dirty(): string[] {
  try {
    const entries = git("status", "--porcelain").split("\n").filter(Boolean);
    return section(
      `Незакоммиченное (${String(entries.length)}):`,
      entries.slice(0, dirtyLimit).map((line) => clip(line, 80))
    );
  } catch {
    return [];
  }
}

function commits(): string[] {
  try {
    const log = git(
      "log",
      `-${String(commitCount)}`,
      "--format=%h %ad %s",
      "--date=short"
    );
    return section(
      "Последние коммиты:",
      log.split("\n").map((line) => clip(line))
    );
  } catch {
    return [];
  }
}

function report(): string {
  let branch: string;
  try {
    branch = git("rev-parse", "--abbrev-ref", "HEAD");
  } catch {
    return "## Состояние репозитория (session-start)\nGit недоступен — справка по состоянию пуста.";
  }

  return [
    "## Состояние репозитория (session-start)",
    `Ветка \`${branch}\`.`,
    ...dirty(),
    ...commits(),
  ].join("\n");
}

try {
  process.stdout.write(`${report()}\n`);
} catch (error) {
  // Тихо: единственное, что хуже пустой справки на старте, — сессия, которая
  // начинается с чужого стектрейса.
  process.stderr.write(`session-start hook: ${String(error)}\n`);
}

// Что агент видит в начале каждой сессии, помимо CLAUDE.md и MEMORY.md.
//
// Те два файла статичны и едут через git — они помнят, как устроен проект и
// что мы поняли на прошлых заходах. Здесь противоположное: состояние на
// сейчас, которое в файл не положишь, потому что оно протухает с каждым
// коммитом. Ветка, последние коммиты, незакоммиченное, живые цели из
// `.harness/goals`.
//
// Хук печатает в stdout, и Claude Code добавляет это в контекст сессии
// (SessionStart — одно из немногих событий, где так). Значит, каждая строка
// стоит токенов в каждой сессии: вывод намеренно узкий и усечённый.
//
// Падать этот хук права не имеет — сломанный старт сессии дороже, чем
// отсутствующая справка, — поэтому всё обёрнуто и выход всегда 0.
import { execFileSync } from "node:child_process";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

const ROOT = process.env.CLAUDE_PROJECT_DIR || process.cwd();
const COMMITS = 5;
const GOALS = 3;
const NOTE_CHARS = 110;

function git(...args: string[]): string {
  return execFileSync("git", args, {
    cwd: ROOT,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
    timeout: 5_000,
  }).trim();
}

function clip(text: string, max = NOTE_CHARS): string {
  const flat = text.replace(/\s+/gu, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

type Goal = { id: string; status: string; touched: number; last: string };

/** Последнее событие цели — это последняя непустая строка `events.jsonl`. */
function lastEvent(dir: string): string {
  const lines = readFileSync(join(dir, "events.jsonl"), "utf8")
    .split("\n")
    .filter((line) => line.trim());
  const raw = lines.at(-1);
  if (!raw) return "";
  try {
    const e = JSON.parse(raw) as { ts?: string; event?: string; note?: string };
    const when = (e.ts ?? "").slice(0, 10);
    return clip([when, e.event, e.note].filter(Boolean).join(" · "));
  } catch {
    return clip(raw);
  }
}

// `state.json` есть не у каждой цели — у старых его просто не заводили, и это
// не повод их прятать. Без него статус неизвестен, а свежесть меряется по
// файлу событий.
function readGoal(id: string): Goal | undefined {
  const dir = join(ROOT, ".harness", "goals", id);
  let touched = 0;
  let last = "";
  try {
    touched = statSync(join(dir, "events.jsonl")).mtimeMs;
    last = lastEvent(dir);
  } catch {
    try {
      touched = statSync(dir).mtimeMs;
    } catch {
      return undefined;
    }
  }
  let status = "?";
  try {
    status = String(
      (JSON.parse(readFileSync(join(dir, "state.json"), "utf8")) as { status?: string }).status ?? "?",
    );
  } catch {
    // статуса нет — так и напишем
  }
  return { id, status, touched, last };
}

function goals(): Goal[] {
  let ids: string[];
  try {
    ids = readdirSync(join(ROOT, ".harness", "goals"), { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name);
  } catch {
    return [];
  }
  return ids
    .map(readGoal)
    .filter((g): g is Goal => Boolean(g))
    .sort((a, b) => b.touched - a.touched)
    .slice(0, GOALS);
}

function report(): string {
  const out: string[] = ["## Состояние репозитория (session-start)"];

  try {
    out.push(`Ветка \`${git("rev-parse", "--abbrev-ref", "HEAD")}\`.`);
  } catch {
    out.push("Git недоступен — дальше только то, что читается с диска.");
  }

  try {
    const dirty = git("status", "--porcelain").split("\n").filter(Boolean);
    if (dirty.length) {
      out.push(
        "",
        `Незакоммиченное (${dirty.length}):`,
        ...dirty.slice(0, 10).map((line) => `- ${clip(line, 80)}`),
      );
    }
  } catch {
    // не смертельно
  }

  try {
    const log = git("log", `-${COMMITS}`, "--format=%h %ad %s", "--date=short");
    if (log) out.push("", "Последние коммиты:", ...log.split("\n").map((l) => `- ${clip(l)}`));
  } catch {
    // не смертельно
  }

  const found = goals();
  if (found.length) {
    out.push("", "Цели в `.harness/goals` (свежие сверху):");
    for (const g of found) {
      const mark = g.status === "done" ? "закрыта" : `в работе (${g.status})`;
      out.push(`- **${g.id}** — ${mark}${g.last ? `; последнее: ${g.last}` : ""}`);
    }
    out.push(
      "Продолжаешь одну из них — прочитай её `goal.md` и `continuation.md` целиком; подробности в `.claude/memory/harness-goals.md`.",
    );
  }

  return out.join("\n");
}

try {
  process.stdout.write(`${report()}\n`);
} catch (err) {
  // Тихо: единственное, что хуже пустой справки на старте — сессия, которая
  // начинается с чужого стектрейса.
  process.stderr.write(`session-start hook: ${err instanceof Error ? err.message : String(err)}\n`);
}

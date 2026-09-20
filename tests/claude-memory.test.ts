import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { z } from "zod";

/**
 * Границы памяти сессии — `CLAUDE.md`, `.claude/memory/` и SessionStart-хук.
 *
 * Ломается она бесшумно: переименованный файл темы, съехавший `@`-импорт,
 * индекс, переросший 200 строк (всё сверх лимита Claude Code просто не
 * грузит). Ничего не падает и не краснеет — следующая сессия молча стартует
 * без половины памяти, и заметно это только по тому, что агент снова не знает
 * того, что уже знал.
 */

const root = new URL("../", import.meta.url);
const index = ".claude/memory/MEMORY.md";

async function read(path: string) {
  return await readFile(new URL(path, root), "utf8");
}

describe("session memory", () => {
  it("loads the agent contract and the memory index in every session", async () => {
    const imports = (await read("CLAUDE.md"))
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean);

    expect(imports).toEqual(["@AGENTS.md", `@${index}`]);
  });

  it("keeps the index within what a session start actually loads", async () => {
    const memory = await read(index);

    expect(memory.split("\n").length).toBeLessThanOrEqual(200);
    expect(Buffer.byteLength(memory, "utf8")).toBeLessThanOrEqual(25_000);
  });

  it("resolves every topic the index points at", async () => {
    const memory = await read(index);
    const topics = [...memory.matchAll(/^- `([\w.-]+\.md)`/gmu)]
      .map((match) => match[1])
      .filter((topic) => topic !== undefined);

    expect(topics.length).toBeGreaterThan(0);
    for (const topic of topics) {
      expect(existsSync(`.claude/memory/${topic}`)).toBe(true);
    }
  });

  it("runs the session-start hook the settings declare", async () => {
    // Ровно один вход и ровно один хук: лишний — это второй голос в контексте
    // каждой сессии, и он должен появляться осознанно.
    const [entry] = z
      .object({
        hooks: z.object({
          SessionStart: z.tuple([
            z.object({
              matcher: z.string(),
              hooks: z.tuple([z.object({ command: z.string() })]),
            }),
          ]),
        }),
      })
      .parse(JSON.parse(await read(".claude/settings.json")))
      .hooks.SessionStart;

    expect(entry.matcher).toContain("startup");
    // Рабочий каталог хука не гарантирован, поэтому путь идёт через плейсхолдер.
    expect(entry.hooks[0].command).toBe(
      "node --experimental-strip-types ${CLAUDE_PROJECT_DIR}/scripts/session-start.ts"
    );

    // Хук читает git и диск, ничего не пишет и не ходит в сеть: прогнать его
    // целиком дешевле, чем узнать о падении на старте сессии.
    const output = execFileSync(
      process.execPath,
      ["--experimental-strip-types", "scripts/session-start.ts"],
      {
        cwd: fileURLToPath(root),
        encoding: "utf8",
        timeout: 15_000,
      }
    );

    expect(output).toContain("## Состояние репозитория");
    expect(output).toContain("Последние коммиты:");
  });
});

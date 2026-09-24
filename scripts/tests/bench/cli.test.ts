import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const entry = fileURLToPath(new URL("../../bench/run.ts", import.meta.url));

/**
 * Runs the real command line. The host is a closed local port and the cookie
 * file does not exist, so a regression that starts a run fails fast instead
 * of reaching production.
 */
function bench(...args: string[]) {
  return spawnSync(
    process.execPath,
    [
      "--experimental-strip-types",
      entry,
      ...args,
      "--host",
      "http://127.0.0.1:9",
      "--cookie-file",
      "/nonexistent/bro-bench-cookies.txt",
    ],
    { encoding: "utf8", timeout: 30_000 }
  );
}

describe("pnpm bench", () => {
  it("refuses a stray word after the command instead of running every case", () => {
    const result = bench("run", "typo");

    expect(result.status).toBe(2);
    expect(result.stderr).toContain("Лишние аргументы: typo");
  });

  it("refuses an unknown command", () => {
    const result = bench("runn");

    expect(result.status).toBe(2);
    expect(result.stderr).toContain("Нет такой команды: runn");
  });

  it("wants seed, clean or list after fixtures", () => {
    const result = bench("fixtures", "sow");

    expect(result.status).toBe(2);
    expect(result.stderr).toContain(
      "После fixtures нужно seed, clean или list"
    );
  });

  it("prints what seeding would insert without reaching Composio", () => {
    const result = bench(
      "fixtures",
      "seed",
      "--case",
      "d10-proactive,d05_email",
      "--dry-run",
      "--mailbox",
      "someone@gmail.com"
    );

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("flight-ru — рейс завтра из Внуково");
    expect(result.stdout).toContain("<someone+sam@gmail.com>");
    expect(result.stdout).toContain("проверить:");
  });

  it("does not seed every case at once by accident", () => {
    const result = bench("fixtures", "seed");

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("Choose the cases to seed");
  });
});

import { execFile, spawnSync } from "node:child_process";
import { mkdtemp, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { z } from "zod";

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

describe("pnpm bench on a way out that drops a request", () => {
  it("checks eve's health again after a reset instead of failing", async () => {
    // The site the command signs in to and the eve it watches, just enough
    // for `observe --minutes 0`; the first health check is cut off.
    let healthChecks = 0;
    const server = createServer((request, response) => {
      const { pathname } = new URL(request.url ?? "/", "http://bench.invalid");
      if (pathname === "/eve/v1/health") {
        healthChecks += 1;
        if (healthChecks === 1) {
          request.socket.destroy();
          return;
        }
      }
      const answer = new Map<string, readonly [string, string]>([
        [
          "/api/auth/get-session",
          [
            "application/json",
            JSON.stringify({
              session: { expiresAt: "2099-01-01T00:00:00.000Z" },
              user: { id: "user_1" },
            }),
          ],
        ],
        [
          "/eve/v1/health",
          [
            "application/json",
            JSON.stringify({
              ok: true,
              status: "ready",
              workflowId: "wf_fake",
            }),
          ],
        ],
        ["/eve/v1/session/wrun_fake/stream", ["application/x-ndjson", ""]],
      ]).get(pathname);
      if (!answer) {
        response.writeHead(404).end();
        return;
      }
      response.writeHead(200, {
        "content-type": answer[0],
        "x-eve-stream-tail-index": "-1",
        "x-eve-stream-version": "25",
      });
      response.end(answer[1]);
    });
    await new Promise<void>((resolve) => {
      server.listen(0, "127.0.0.1", resolve);
    });
    const { port } = z.object({ port: z.number() }).parse(server.address());
    const home = await mkdtemp(join(tmpdir(), "bench-cli-"));
    const cookieFile = join(home, "cookies.txt");
    await writeFile(cookieFile, "session=1\n");

    try {
      const { stderr } = await promisify(execFile)(
        process.execPath,
        [
          "--experimental-strip-types",
          entry,
          "observe",
          "--out",
          join(home, "runs"),
          "--case",
          "d10-proactive",
          "--session",
          "wrun_fake",
          "--minutes",
          "0",
          "--host",
          `http://127.0.0.1:${String(port)}`,
          "--cookie-file",
          cookieFile,
        ],
        {
          encoding: "utf8",
          // Nothing of this environment: the fixtures manifest is read from
          // the home directory, and no proxy stands before the local server.
          env: { HOME: home, NODE_ENV: "test" },
          timeout: 30_000,
        }
      );

      expect(healthChecks).toBe(2);
      expect(stderr).toContain(
        "GET /eve/v1/health: сбой сети (UND_ERR_SOCKET: other side closed) — повтор через 2 с (1/4)"
      );
    } finally {
      server.closeAllConnections();
      server.close();
    }
  }, 40_000);
});

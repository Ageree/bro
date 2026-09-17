// The harness testing itself.
//
// `scripts/e2e.ts` only earns trust if it fails when Bro is wrong and passes
// when Bro is right, and neither property can be observed from a run against a
// real deployment — a green suite there is equally consistent with a runner
// that asserts nothing. So this stands up a fake Bro on localhost, one that
// verifies the signature for real and answers from a script, and drives the
// runner against it: once with replies that satisfy the scenario, once with
// replies that do not, once with silence.
//
// It needs no secrets and no network, so it runs in CI next to everything else.
import { spawn } from "node:child_process";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { once } from "node:events";
import type { AddressInfo } from "node:net";

import { photonWebhookOk } from "../agent/lib/photon.ts";
import { isTestPhone, testPhoneFor } from "../convex/lib/testTenantPolicy.ts";
import { welcomeBubbles } from "../agent/lib/onboard-policy.ts";

import { assert, eq } from "./lib/check.ts";

const SECRET = "internal-secret-for-the-fake";
const WEBHOOK_SECRET = "webhook-secret-for-the-fake";
const LETTER = welcomeBubbles()[0]!;

type Row = { at: number; channel: string; text: string; bubbles: string[]; note?: string };
/** What the fake answers with, in order, for each inbound it receives. */
type Script = (string | { text: string; note?: string })[][];

async function body(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString("utf8");
}

/**
 * A Bro-shaped server: the same three routes the runner talks to, with the
 * same signature check and the same "reply lands in the transcript later"
 * shape. `seen` counts inbounds so each turn can answer differently.
 */
async function fakeBro(script: Script) {
  const rows = new Map<string, Row[]>();
  const seen = new Map<string, number>();
  let signatureFailures = 0;
  let resets = 0;

  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    void (async () => {
      const raw = await body(req);
      const json = (() => {
        try {
          return JSON.parse(raw) as Record<string, unknown>;
        } catch {
          return {};
        }
      })();

      if (req.url === "/webhooks/photon") {
        if (!photonWebhookOk(Buffer.from(raw), new Headers(req.headers as Record<string, string>), WEBHOOK_SECRET)) {
          signatureFailures += 1;
          res.writeHead(401).end("unauthorized");
          return;
        }
        const message = json.message as { sender?: { id?: string } } | undefined;
        const phone = message?.sender?.id ?? "";
        const turn = seen.get(phone) ?? 0;
        seen.set(phone, turn + 1);
        const replies = script[turn] ?? [];
        const list = rows.get(phone) ?? [];
        for (const reply of replies) {
          const entry = typeof reply === "string" ? { text: reply } : reply;
          list.push({
            at: Date.now(),
            channel: "imessage",
            text: entry.text,
            bubbles: [entry.text],
            ...(entry.note ? { note: entry.note } : {}),
          });
        }
        rows.set(phone, list);
        res.writeHead(204).end();
        return;
      }

      if (json.secret !== SECRET) {
        res.writeHead(401).end("unauthorized");
        return;
      }
      const phone = typeof json.phone === "string" ? json.phone : "";
      if (!isTestPhone(phone)) {
        res.writeHead(400).end("not a test phone");
        return;
      }
      if (req.url === "/internal/test/reset") {
        resets += 1;
        rows.delete(phone);
        seen.delete(phone);
        res.writeHead(200, { "content-type": "application/json" }).end(
          JSON.stringify({ ok: true }),
        );
        return;
      }
      if (req.url === "/internal/test/transcript") {
        res.writeHead(200, { "content-type": "application/json" }).end(
          JSON.stringify({ ok: true, bubbles: rows.get(phone) ?? [] }),
        );
        return;
      }
      res.writeHead(404).end("nope");
    })();
  });

  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const { port } = server.address() as AddressInfo;
  return {
    base: `http://127.0.0.1:${port}`,
    stats: () => ({ signatureFailures, resets }),
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

async function runner(base: string, args: string[], env?: Record<string, string>) {
  const child = spawn(
    process.execPath,
    [
      "--experimental-strip-types",
      new URL("./e2e.ts", import.meta.url).pathname,
      `--base=${base}`,
      // Tight timings: the fake answers instantly, so the suite should not
      // spend the production settle window per turn.
      "--settle=150",
      "--poll=30",
      "--turn-timeout=4000",
      ...args,
    ],
    {
      env: {
        ...process.env,
        BRO_INTERNAL_SECRET: SECRET,
        SPECTRUM_WEBHOOK_SECRET: WEBHOOK_SECRET,
        ...env,
      },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  let out = "";
  child.stdout.on("data", (c) => (out += c));
  child.stderr.on("data", (c) => (out += c));
  const [code] = (await once(child, "close")) as [number];
  return { code, out };
}

// ------------------------------------------------- Bro answers correctly

{
  // onboard-letter: letter on first contact, then a greeting that is not the
  // letter. Exactly what the product is supposed to do.
  const bro = await fakeBro([[LETTER], [{ text: "ищу", note: "fast-ack" }, "привет! чем помочь?"]]);
  const { code, out } = await runner(bro.base, ["--only=onboard-letter"]);
  eq(code, 0, `a correct Bro passes:\n${out}`);
  assert(out.includes("ok   onboard-letter"), `scenario reported ok:\n${out}`);
  assert(out.includes("1/1 scenarios passed"), `summary counts the pass:\n${out}`);
  const stats = bro.stats();
  eq(stats.signatureFailures, 0, "the runner signs the webhook the way Bro verifies it");
  eq(stats.resets, 1, "each scenario resets its tenant before the first turn");
  await bro.close();
}

// ------------------------------------------------ Bro repeats the letter

{
  // The #107 regression: the letter goes out again on the second «привет».
  const bro = await fakeBro([[LETTER], [LETTER]]);
  const { code, out } = await runner(bro.base, ["--only=onboard-letter"]);
  eq(code, 1, `a repeated letter fails the suite:\n${out}`);
  assert(out.includes("FAIL onboard-letter"), `the failing scenario is named:\n${out}`);
  assert(out.includes("expected nothing containing"), `the reason is printed:\n${out}`);
  // The transcript of the failing turn is the thing a human needs to debug.
  assert(out.includes("human: привет"), `the human side is printed:\n${out}`);
  assert(out.includes("bro:"), `Bro's side is printed:\n${out}`);
  await bro.close();
}

// ------------------------------------------------------ Bro goes silent

{
  const bro = await fakeBro([[LETTER], []]);
  const { code, out } = await runner(bro.base, ["--only=onboard-letter"]);
  eq(code, 1, `silence fails the suite:\n${out}`);
  assert(out.includes("expected a reply, got silence"), `silence is named as such:\n${out}`);
  assert(out.includes("(silence)"), `the empty turn is shown in the transcript:\n${out}`);
  await bro.close();
}

// ------------------------------- only the fast ack arrives, turn says nothing

{
  // The case the `note` plumbing exists for: the pre-turn status line lands,
  // the turn itself dies. Without the marker this would read as a reply.
  const bro = await fakeBro([[LETTER], [{ text: "смотрю", note: "fast-ack" }]]);
  const { code, out } = await runner(bro.base, ["--only=onboard-letter"]);
  eq(code, 1, `a fast-ack-only turn fails:\n${out}`);
  assert(
    out.includes("only the fast-ack arrived"),
    `the fast-ack-only case is named precisely:\n${out}`,
  );
  await bro.close();
}

// ------------------------------------------------------ operational guards

{
  const bro = await fakeBro([[LETTER]]);
  const missing = await runner(bro.base, ["--only=onboard-letter"], {
    BRO_INTERNAL_SECRET: "",
  });
  eq(missing.code, 2, `a missing secret exits 2, not 1:\n${missing.out}`);
  assert(
    missing.out.includes("BRO_INTERNAL_SECRET"),
    `the missing secret is named:\n${missing.out}`,
  );

  const unknown = await runner(bro.base, ["--only=no-such-scenario"]);
  eq(unknown.code, 2, `an unknown scenario name exits 2:\n${unknown.out}`);
  assert(unknown.out.includes("unknown scenario"), `and says so:\n${unknown.out}`);

  const wrongSecret = await runner(bro.base, ["--only=onboard-letter"], {
    BRO_INTERNAL_SECRET: "not-the-secret",
  });
  eq(wrongSecret.code, 1, `a rejected secret fails the run:\n${wrongSecret.out}`);
  assert(
    wrongSecret.out.includes("401"),
    `the transport error is surfaced, not swallowed:\n${wrongSecret.out}`,
  );
  await bro.close();
}

// ------------------------------------------------------------- isolation

{
  // Two scenarios in one run must not share a tenant, or one's memory steers
  // the other's turn and the failure looks like a model bug.
  const names = ["onboard-letter", "help-letter"];
  const phones = new Set(names.map(testPhoneFor));
  eq(phones.size, names.length, "scenarios run against different tenants");
}

console.log("e2e check ok");

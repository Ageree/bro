import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  BoxHttpError,
  createBoxClient,
  type BoxRecord,
} from "../agent/lib/boxClient.ts";

function loadDotEnvLocal(): void {
  const envPath = resolve(import.meta.dirname, "../.env.local");
  if (!existsSync(envPath)) return;
  for (const line of readFileSync(envPath, "utf8").split(/\r?\n/)) {
    const t = line.trim();
    if (!t || t.startsWith("#")) continue;
    const body = t.startsWith("export ") ? t.slice(7).trim() : t;
    const i = body.indexOf("=");
    if (i < 0) continue;
    const k = body.slice(0, i).trim();
    let v = body.slice(i + 1);
    if (
      (v.startsWith('"') && v.endsWith('"') && v.length >= 2) ||
      (v.startsWith("'") && v.endsWith("'") && v.length >= 2)
    ) {
      v = v.slice(1, -1);
    }
    if (process.env[k] === undefined) process.env[k] = v;
  }
}

async function timed<T>(label: string, fn: () => Promise<T>): Promise<T> {
  const t0 = Date.now();
  try {
    return await fn();
  } finally {
    console.log(`${label} ${Date.now() - t0}ms`);
  }
}

function formatError(err: unknown): string {
  if (err instanceof BoxHttpError) return `${err.status} ${err.code}`;
  if (err instanceof Error) return err.message;
  return "error";
}

async function archiveBestEffort(
  client: ReturnType<typeof createBoxClient>,
  boxId: string | undefined,
): Promise<void> {
  if (!boxId) return;
  try {
    const cur = await client.get(boxId);
    if (cur.state === "archived" || cur.state === "archiving") {
      if (cur.state === "archiving") {
        await client.waitUntil(boxId, ["archived"], 180_000);
      }
      return;
    }
    await client.stop(boxId);
    await client.waitUntil(boxId, ["archived"], 180_000);
  } catch (err) {
    console.log(`cleanup ${formatError(err)}`);
  }
}

loadDotEnvLocal();

if (!process.env.BOX_API_KEY?.trim()) {
  console.log("skip: no BOX_API_KEY");
  process.exit(0);
}

const client = createBoxClient();
const spikeStart = Date.now();
let box: BoxRecord | undefined;

try {
  const before = await timed("limits_before", () => client.limits());
  console.log(
    "canStart",
    before.canStart,
    "blocked",
    before.startBlockedReason ?? "none",
  );
  if (!before.canStart) {
    throw new Error(before.startBlockedReason ?? "billing_required");
  }

  box = await timed("create", () =>
    client.create({
      type: "small",
      noEnv: true,
      ttlSeconds: 900,
      env: { TENANT_ID: "spike" },
    }),
  );
  console.log("box", box.id, box.state);

  const ready = await timed("wait_ready", () =>
    client.waitUntil(box!.id, ["ready", "idle"], 180_000),
  );
  console.log("ready", ready.state, "archiveAfter", ready.archiveAfter ?? "none");

  await timed("write", () =>
    client.writeFile(box!.id, "/home/user/bro-spike.txt", "hello-bro"),
  );

  const cat1 = await timed("cat", () =>
    client.command(box!.id, { command: "cat /home/user/bro-spike.txt" }),
  );
  if (!cat1.stdout.includes("hello-bro")) {
    throw new Error("cat mismatch before stop");
  }
  console.log("cat_ok", cat1.exitCode);

  const beforePatch = ready.archiveAfter;
  const patched = await timed("patch_ttl", () =>
    client.update(box!.id, { ttlSeconds: 900 }),
  );
  const moved =
    beforePatch == null ||
    patched.archiveAfter == null ||
    patched.archiveAfter !== beforePatch;
  console.log(
    "archiveAfter_moved",
    moved,
    "before",
    beforePatch ?? "none",
    "after",
    patched.archiveAfter ?? "none",
  );

  await timed("stop", () => client.stop(box!.id));
  await timed("wait_archived", () =>
    client.waitUntil(box!.id, ["archived"], 180_000),
  );

  const resumed = await timed("resume", () =>
    client.resume(box!.id, { noEnv: true, ttlSeconds: 900 }),
  );
  console.log("resume", resumed.state);
  const afterResume = await timed("wait_resume", () =>
    client.waitUntil(box!.id, ["ready", "idle"], 180_000),
  );
  console.log("resumed", afterResume.state);

  const cat2 = await timed("cat_after_resume", () =>
    client.command(box!.id, { command: "cat /home/user/bro-spike.txt" }),
  );
  if (!cat2.stdout.includes("hello-bro")) {
    throw new Error("cat mismatch after resume");
  }
  console.log("cat_after_resume_ok", cat2.exitCode);

  const limits = await timed("limits", () => client.limits());
  console.log("starts_day_remaining", limits.starts?.day?.remaining ?? "none");

  await timed("stop_final", () => client.stop(box!.id));
  await timed("wait_archived_final", () =>
    client.waitUntil(box!.id, ["archived"], 180_000),
  );
  box = undefined;

  console.log("spike_ok", `${Date.now() - spikeStart}ms`);
} catch (err) {
  console.log("spike_error", formatError(err));
  await archiveBestEffort(client, box?.id);
  process.exit(1);
}

import { BoxHttpError, type BoxState } from "../agent/lib/boxClient.ts";
import { ensureRunning, type ComputerStore } from "../agent/lib/computer.ts";
import type { ComputerRow } from "../agent/lib/convex.ts";
import {
  BRO_COMPUTER_START_RESERVE,
  BRO_COMPUTER_TTL_SECONDS,
  canSpendStart,
  nextCommandAction,
  shouldRenewTtl,
} from "../convex/lib/computerPolicy.ts";
import { createFakeBox } from "./lib/fake-box.ts";

function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(msg);
}

const WAIT: BoxState[] = [
  "init",
  "provisioning",
  "provisioned",
  "cloning",
  "archiving",
];
for (const state of WAIT) {
  assert(nextCommandAction(state) === "wait", `wait ${state}`);
}

assert(nextCommandAction("ready") === "command", "ready");
assert(nextCommandAction("idle") === "command", "idle");
assert(nextCommandAction("running") === "command", "running");
assert(nextCommandAction("archived") === "resume", "archived");
assert(nextCommandAction("error") === "error", "error");

const now = 1_000_000;
const half = (BRO_COMPUTER_TTL_SECONDS / 2) * 1000;
assert(shouldRenewTtl(undefined, now) === true, "ttl missing");
assert(shouldRenewTtl(null, now) === true, "ttl null");
assert(shouldRenewTtl(now + half - 1, now) === true, "ttl below half");
assert(shouldRenewTtl(now + half, now) === false, "ttl at half");
assert(shouldRenewTtl(now + half + 1, now) === false, "ttl above half");
assert(shouldRenewTtl(now + 49_999, now, 100) === true, "custom ttl renew");
assert(shouldRenewTtl(now + 50_000, now, 100) === false, "custom ttl hold");

assert(
  canSpendStart({ canStart: false, remaining: 100 }) === false,
  "start blocked",
);
assert(
  canSpendStart({ canStart: true, remaining: BRO_COMPUTER_START_RESERVE - 1 }) ===
    false,
  "below reserve",
);
assert(
  canSpendStart({ canStart: true, remaining: BRO_COMPUTER_START_RESERVE }) ===
    true,
  "at reserve",
);
assert(canSpendStart({ canStart: true, remaining: 11 }) === true, "above reserve");
assert(canSpendStart({ canStart: true }) === true, "no remaining");
assert(
  canSpendStart({ canStart: true, remaining: 2, reserve: 3 }) === false,
  "custom reserve",
);
assert(
  canSpendStart({ canStart: true, remaining: 3, reserve: 3 }) === true,
  "custom reserve at",
);

let clock = 1_700_000_000_000;
const fake = createFakeBox({ now: () => clock });

const created = await fake.create({
  type: "small",
  noEnv: true,
  ttlSeconds: 900,
  env: { TENANT_ID: "spike" },
});
assert(created.state === "provisioning", "create starts provisioning");
assert(created.type === "small", "create type");
assert(created.archiveAfter === clock + 900_000, "create archiveAfter");

try {
  await fake.command(created.id, { command: "true" });
  throw new Error("command before ready must 409");
} catch (err) {
  assert(err instanceof BoxHttpError, "409 is BoxHttpError");
  assert(err.status === 409, "409 status");
  assert(err.code === "box_starting", "409 code");
}

const ready = await fake.get(created.id);
assert(ready.state === "ready", "get advances to ready");

clock += 10_000;
const patched = await fake.update(created.id, { ttlSeconds: 900 });
assert(patched.archiveAfter === clock + 900_000, "PATCH archiveAfter from now");
assert(
  patched.archiveAfter !== created.archiveAfter,
  "PATCH moves archiveAfter",
);

await fake.writeFile(created.id, "/home/user/bro-spike.txt", "hello-bro");
assert(
  (await fake.readFile(created.id, "/home/user/bro-spike.txt")) === "hello-bro",
  "write/read",
);

const stopping = await fake.stop(created.id);
assert(stopping.state === "archiving", "stop archiving");
const archived = await fake.get(created.id);
assert(archived.state === "archived", "get advances to archived");

const resumed = await fake.resume(created.id, {
  noEnv: true,
  ttlSeconds: 900,
});
assert(resumed.state === "ready", "resume ready");
assert(
  (await fake.readFile(created.id, "/home/user/bro-spike.txt")) === "hello-bro",
  "file persists across stop/resume",
);

const cat = await fake.command(created.id, {
  command: "cat /home/user/bro-spike.txt",
});
assert(cat.success && cat.stdout === "hello-bro", "cat after resume");

const limits = await fake.limits();
assert(limits.canStart === true, "limits canStart");
assert(limits.starts?.day?.limit === 150, "limits day limit");
assert(
  typeof limits.starts?.day?.remaining === "number" &&
    limits.starts.day.remaining === 150 - fake.startsToday(),
  "limits remaining",
);
assert(fake.startsToday() === 2, "create + resume count as starts");

function memoryStore(tenantId: string): ComputerStore {
  let row: ComputerRow | null = null;
  const now = 1_700_000_000_000;
  return {
    async get() {
      return row;
    },
    async claim() {
      if (row) return row;
      row = {
        _id: "computers:1",
        tenantId,
        size: "small",
        lastState: "pending",
        lastStateAt: now,
        createdAt: now,
      };
      return row;
    },
    async bind(_phone, boxId, lastState) {
      if (!row) throw new Error("missing claim");
      if (row.boxId && row.boxId !== boxId) return row;
      row = { ...row, boxId, lastState, lastStateAt: now, resumedAt: now };
      return row;
    },
    async setState(_phone, lastState) {
      if (!row) throw new Error("missing claim");
      row = { ...row, lastState, lastStateAt: now };
      return row;
    },
    async touch() {
      if (!row) throw new Error("missing claim");
      row = { ...row, lastActiveAt: now };
      return row;
    },
  };
}

const tenantConvexId = "tenants_parallel";
const store = memoryStore(tenantConvexId);
const parallel = createFakeBox({ now: () => clock });
const [a, b] = await Promise.all([
  ensureRunning({ phoneE164: "+15555550100", store }, parallel),
  ensureRunning({ phoneE164: "+15555550100", store }, parallel),
]);
assert(a.boxId === b.boxId, "parallel ensureRunning shares one box");
assert(parallel.startsToday() === 1, "idempotent create spends one start");

console.log("computer-check ok");

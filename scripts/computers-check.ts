#!/usr/bin/env npx tsx
/**
 * computers-check — one computer row per tenant, claim-before-box, no phone on this plane.
 *
 * Run: npm run computers:check
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const schemaSrc = readFileSync(join(root, "convex/schema.ts"), "utf8");
const computersSrc = readFileSync(join(root, "convex/computers.ts"), "utf8");
const storeSrc = readFileSync(join(root, "convex/lib/computerStore.ts"), "utf8");

assert.match(schemaSrc, /computers:\s*defineTable/, "schema must declare computers");
assert.match(schemaSrc, /computerLockAt:\s*v\.optional\(v\.number\(\)\)/, "tenants.computerLockAt is the claim mutex");
assert.match(schemaSrc, /boxId:\s*v\.optional\(v\.string\(\)\)/, "boxId is optional until bind");
assert.match(schemaSrc, /\.index\("by_tenant",\s*\["tenantId"\]\)/, "computers need by_tenant");
assert.match(schemaSrc, /\.index\("by_box",\s*\["boxId"\]\)/, "computers need by_box");
assert.match(
  schemaSrc,
  /accountId:\s*v\.string\(\)/,
  "chatgptAccounts.accountId is required after OAuth",
);
assert.match(
  schemaSrc,
  /\.index\("by_deviceAuthId",\s*\["deviceAuthId"\]\)/,
  "chatgptLogins need by_deviceAuthId for the poller",
);

assert.match(computersSrc, /export const getByTenant/, "computers.getByTenant");
assert.match(computersSrc, /export const claimOrGet/, "computers.claimOrGet");
assert.match(computersSrc, /export const bindBox/, "computers.bindBox");
assert.match(computersSrc, /export const setState/, "computers.setState");
assert.match(computersSrc, /export const touchActive/, "computers.touchActive");
assert.match(computersSrc, /export const deleteForTenant/, "computers.deleteForTenant");
assert.match(computersSrc, /export const claimForAgent/, "computers.claimForAgent");
assert.match(computersSrc, /export const bindForAgent/, "computers.bindForAgent");
assert.match(computersSrc, /export const getForAgent/, "computers.getForAgent");
assert.match(computersSrc, /export const deleteForAgent/, "computers.deleteForAgent");
assert.doesNotMatch(
  computersSrc,
  /export const getByPhone/,
  "phone lookup is not on the computer plane",
);
assert.doesNotMatch(
  computersSrc,
  /export const insertForTenant/,
  "insertForTenant races with claim; use claimOrGet + bindBox",
);

assert.match(storeSrc, /function computerByTenant/, "store: computerByTenant");
assert.match(
  storeSrc,
  /rows\.slice\(\)\.sort\(\(a, b\) => a\._creationTime - b\._creationTime\)/,
  "oldest Convex row wins",
);
assert.match(storeSrc, /lastState:\s*PENDING_COMPUTER_STATE|"pending"/, "first claim is pending, no box yet");
assert.match(storeSrc, /export async function bindComputerBox/, "store: bindComputerBox");
assert.match(storeSrc, /export async function claimOrGetComputer/, "store: claimOrGetComputer");
assert.match(storeSrc, /computerLockAt/, "claim patches the tenant as an OCC mutex");
assert.doesNotMatch(storeSrc, /\.unique\(\)/, "do not use .unique() — it bricks delete");
assert.match(
  storeSrc,
  /schema\.tables\.computers\.validator\.fields\.size/,
  "size validator comes from schema, not a copy",
);

console.log("computers-check: ok");

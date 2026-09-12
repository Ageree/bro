#!/usr/bin/env npx tsx
/**
 * files-check — Convex files table + agent tools + personal-only.
 *
 * Run: npm run files:check
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import {
  FILE_BINARY_MAX,
  FILE_TEXT_READ_MAX,
  FILE_TEXT_WRITE_MAX,
  sanitizeFileName,
} from "../convex/lib/fileStore.ts";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const schemaSrc = readFileSync(join(root, "convex/schema.ts"), "utf8");
const filesSrc = readFileSync(join(root, "convex/files.ts"), "utf8");
const storeSrc = readFileSync(join(root, "convex/lib/fileStore.ts"), "utf8");
const instructions = readFileSync(join(root, "agent/instructions.md"), "utf8");

assert.match(schemaSrc, /files:\s*defineTable/, "schema must declare files");
assert.match(schemaSrc, /storageId:\s*v\.id\("_storage"\)/, "files.storageId");
assert.match(
  schemaSrc,
  /\.index\("by_tenant",\s*\["tenantId"\]\)/,
  "files need by_tenant",
);
assert.match(
  schemaSrc,
  /\.index\("by_tenant_and_name",\s*\["tenantId",\s*"name"\]\)/,
  "files need by_tenant_and_name",
);
assert.doesNotMatch(filesSrc, /\.filter\(/, "files queries use indexes");
assert.match(filesSrc, /export const listForAgent/, "listForAgent");
assert.match(filesSrc, /export const getForAgent/, "getForAgent");
assert.match(filesSrc, /export const generateUploadUrlForAgent/, "upload url");
assert.match(filesSrc, /export const saveForAgent/, "saveForAgent");
assert.match(filesSrc, /export const deleteForAgent/, "deleteForAgent");
assert.match(filesSrc, /export const storeBytesForAgent/, "storeBytes action");
assert.match(filesSrc, /returns:/, "validators on functions");
assert.match(storeSrc, /function sanitizeFileName/, "sanitize names");

assert.equal(sanitizeFileName("a/b/c.txt"), "c.txt", "basename only");
assert.equal(sanitizeFileName("  note.txt  "), "note.txt", "trim");
assert.equal(sanitizeFileName("../secret.txt"), "secret.txt", "strip parent dirs");
assert.throws(() => sanitizeFileName(".."), "reject ..");
assert.throws(() => sanitizeFileName(""), "reject empty");
assert.ok(FILE_TEXT_WRITE_MAX === 256 * 1024, "256KB text write");
assert.ok(FILE_TEXT_READ_MAX === 64 * 1024, "64KB text read");
assert.ok(FILE_BINARY_MAX === 8 * 1024 * 1024, "8MB binary");

for (const tool of [
  "files_list.ts",
  "files_get.ts",
  "files_save.ts",
  "files_delete.ts",
  "sandbox_run.ts",
]) {
  const src = readFileSync(join(root, "agent/tools", tool), "utf8");
  assert.match(src, /asPersonal/, `${tool} is personal-only`);
  assert.match(src, /defineTool/, `${tool} is an eve tool`);
}

assert.match(instructions, /files_list/, "instructions list files tools");
assert.match(instructions, /sandbox_run/, "instructions route processing");
assert.match(instructions, /browser_task/, "instructions keep sites on browser");
assert.doesNotMatch(
  instructions,
  /Файлы, скрипты, git и CLI — `computer_\*`/,
  "instructions no longer route files to computer_*",
);

const inbound = readFileSync(join(root, "agent/lib/inbound-files.ts"), "utf8");
assert.match(inbound, /saveTelegramInboundFiles/, "telegram inbound save");
assert.match(inbound, /savePhotonInboundFiles/, "photon inbound save");

const sendPhoto = readFileSync(join(root, "agent/lib/send-photo.ts"), "utf8");
assert.match(sendPhoto, /photoFromStoredFile/, "send-photo uses storage");
assert.doesNotMatch(sendPhoto, /readBinaryFile/, "send-photo does not read the box");

console.log("files-check: ok");

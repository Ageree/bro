/** Document validators must be derived from the schema, never hand-copied.
 *
 *  Incident 2026-09-05: `tenantDoc` in convex/tenants.ts was a hand-copied
 *  field list. `archiveSyncedAt` was added to the schema (#15) but not to
 *  the copy; the first hourly archive sync wrote that column, and from then
 *  on every tenant query/mutation threw `ReturnsValidationError`. The
 *  webhook swallowed the error, `browser_task` failed twice, the model gave
 *  up, and the person got no reply at all. This check fails the moment a
 *  schema column is missing from a document validator, and rejects new
 *  hand-copied `v.object({ _id: v.id("…") … })` literals in convex/. */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { doc } from "convex-helpers/validators";
import schema from "../convex/schema.ts";

// convex/*.ts pull in _generated/ and extensionless imports Node cannot load,
// so the validator is rebuilt here exactly as convex/tenants.ts builds it and
// the source text is checked to still use that form.
const tenantDoc = doc(schema, "tenants");

function assert(cond: unknown, msg: string): void {
  if (!cond) throw new Error(msg);
}

type TableName = keyof typeof schema.tables;

function schemaFields(table: TableName): string[] {
  return Object.keys(schema.tables[table].validator.fields);
}

function assertCoversTable(
  name: string,
  validator: { fields: Record<string, unknown> },
  table: TableName,
): void {
  const missing = schemaFields(table).filter((f) => !(f in validator.fields));
  assert(
    missing.length === 0,
    `${name} misses schema fields of "${table}": ${missing.join(", ")}`,
  );
  const extra = Object.keys(validator.fields).filter(
    (f) => f !== "_id" && f !== "_creationTime" && !schemaFields(table).includes(f),
  );
  assert(
    extra.length === 0,
    `${name} has fields not in schema "${table}": ${extra.join(", ")}`,
  );
  assert("_id" in validator.fields, `${name} lacks _id`);
  assert("_creationTime" in validator.fields, `${name} lacks _creationTime`);
}

// 1. Every exported document validator matches its table exactly.
assertCoversTable("tenantDoc", tenantDoc, "tenants");
assert(
  "archiveSyncedAt" in tenantDoc.fields,
  "tenantDoc must include archiveSyncedAt (the 2026-09-05 outage column)",
);

// 2. No new hand-copied document validators anywhere in convex/.
//    A full-document validator starts with `_id: v.id("<table>")`; the only
//    accepted way to build one is `doc(schema, "<table>")`.
const convexDir = join(import.meta.dirname, "..", "convex");
const files: string[] = [];
for (const entry of readdirSync(convexDir, { withFileTypes: true })) {
  if (entry.isFile() && entry.name.endsWith(".ts")) {
    files.push(join(convexDir, entry.name));
  } else if (entry.isDirectory() && entry.name === "lib") {
    for (const sub of readdirSync(join(convexDir, "lib"))) {
      if (sub.endsWith(".ts")) files.push(join(convexDir, "lib", sub));
    }
  }
}
const HAND_COPIED = /v\.object\(\{\s*_id:\s*v\.id\(/;
for (const file of files) {
  const src = readFileSync(file, "utf8");
  const m = src.match(HAND_COPIED);
  assert(
    !m,
    `${file.replace(convexDir, "convex")}: hand-copied document validator — use doc(schema, "<table>") from convex-helpers/validators`,
  );
}

// 3. convex/tenants.ts really derives tenantDoc from the schema.
const tenantsSrc = readFileSync(join(convexDir, "tenants.ts"), "utf8");
assert(
  /export const tenantDoc = doc\(schema, "tenants"\);/.test(tenantsSrc),
  'convex/tenants.ts: tenantDoc must be `doc(schema, "tenants")`',
);

// 4. The schema itself stays the single source: doc() picks up new columns.
const sample = schemaFields("tenants");
assert(sample.includes("archiveSyncedAt"), "schema lost archiveSyncedAt");
assert(
  Object.keys(tenantDoc.fields).length === sample.length + 2,
  "tenantDoc field count must be schema fields + _id + _creationTime",
);

console.log(`schema-check ok (${files.length} convex files, ${sample.length} tenant columns)`);

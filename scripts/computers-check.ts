/** Schema + validator check for Bro personal computers and ChatGPT tables.
 *
 *  Same incident class as schema-check.ts: a hand-copied document validator
 *  will throw ReturnsValidationError the first time a new column is written.
 *  This file only covers the new computer / ChatGPT tables. */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { doc } from "convex-helpers/validators";
import schema from "../convex/schema.ts";

function assert(cond: unknown, msg: string): void {
  if (!cond) throw new Error(msg);
}

type TableName = keyof typeof schema.tables;

function schemaFields(table: TableName): string[] {
  return Object.keys(schema.tables[table].validator.fields);
}

function tableIndexes(
  table: TableName,
): { indexDescriptor: string; fields: string[] }[] {
  return schema.tables[table][" indexes"]();
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

function assertTable(
  name: TableName,
  fields: string[],
  indexes: { name: string; fields: string[] }[],
): void {
  assert(name in schema.tables, `schema missing table "${name}"`);
  const have = schemaFields(name);
  const missing = fields.filter((f) => !have.includes(f));
  assert(
    missing.length === 0,
    `"${name}" missing fields: ${missing.join(", ")}`,
  );
  const extra = have.filter((f) => !fields.includes(f));
  assert(extra.length === 0, `"${name}" unexpected fields: ${extra.join(", ")}`);
  const haveIdx = tableIndexes(name);
  for (const idx of indexes) {
    const found = haveIdx.find((row) => row.indexDescriptor === idx.name);
    assert(found, `"${name}" missing index ${idx.name}`);
    assert(
      JSON.stringify(found!.fields) === JSON.stringify(idx.fields),
      `"${name}" index ${idx.name} fields ${JSON.stringify(found!.fields)} != ${JSON.stringify(idx.fields)}`,
    );
  }
}

assertTable(
  "computers",
  [
    "tenantId",
    "boxId",
    "size",
    "lastState",
    "lastStateAt",
    "lastActiveAt",
    "resumedAt",
    "createdAt",
  ],
  [
    { name: "by_tenant", fields: ["tenantId"] },
    { name: "by_box", fields: ["boxId"] },
  ],
);

assertTable(
  "chatgptAccounts",
  [
    "tenantId",
    "accountId",
    "email",
    "planType",
    "connectedAt",
    "version",
    "accessExpiresAt",
    "quarantinedAt",
    "quarantineReason",
  ],
  [{ name: "by_tenant", fields: ["tenantId"] }],
);

assertTable(
  "chatgptSecrets",
  ["tenantId", "ciphertext", "version", "updatedAt"],
  [{ name: "by_tenant", fields: ["tenantId"] }],
);

assertTable(
  "chatgptLogins",
  [
    "tenantId",
    "deviceAuthId",
    "userCode",
    "interval",
    "expiresAt",
    "status",
  ],
  [{ name: "by_tenant", fields: ["tenantId"] }],
);

const computerDoc = doc(schema, "computers");
assertCoversTable("computerDoc", computerDoc, "computers");

const chatgptAccountDoc = doc(schema, "chatgptAccounts");
assertCoversTable("chatgptAccountDoc", chatgptAccountDoc, "chatgptAccounts");
const chatgptSecretDoc = doc(schema, "chatgptSecrets");
assertCoversTable("chatgptSecretDoc", chatgptSecretDoc, "chatgptSecrets");
const chatgptLoginDoc = doc(schema, "chatgptLogins");
assertCoversTable("chatgptLoginDoc", chatgptLoginDoc, "chatgptLogins");

const convexDir = join(import.meta.dirname, "..", "convex");
const owned = ["computers.ts", join("lib", "computerStore.ts")];
const HAND_COPIED = /v\.object\(\{\s*_id:\s*v\.id\(/;
for (const rel of owned) {
  const src = readFileSync(join(convexDir, rel), "utf8");
  assert(
    !HAND_COPIED.test(src),
    `convex/${rel}: hand-copied document validator — use doc(schema, "<table>")`,
  );
}

const computersSrc = readFileSync(join(convexDir, "computers.ts"), "utf8");
assert(
  /export const computerDoc = doc\(schema, "computers"\);/.test(computersSrc),
  'convex/computers.ts: computerDoc must be `doc(schema, "computers")`',
);

const requiredExports = [
  "getByTenant",
  "getByPhone",
  "insertForTenant",
  "setState",
  "touchActive",
  "deleteForTenant",
  "claimOrGet",
];
for (const name of requiredExports) {
  assert(
    computersSrc.includes(`export const ${name} =`),
    `convex/computers.ts missing export ${name}`,
  );
}

console.log(
  `computers-check ok (computers, chatgptAccounts, chatgptSecrets, chatgptLogins; ${requiredExports.length} computer fns)`,
);

import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { z } from "zod";

/**
 * Decoding of an unzipped Convex snapshot. `npx convex export --path <zip>`
 * writes one folder per table, each holding a `documents.jsonl` with one
 * document per line and the deployment's own `_id` and `_creationTime` on
 * every document. Only the tables the new product has a home for are decoded;
 * everything else in the snapshot is left alone.
 */
const convexDocument = z.object({
  _creationTime: z.number(),
  _id: z.string().min(1),
});

/** Gives every decoded document this repository's own naming. */
function renameSystemFields<T extends { _creationTime: number; _id: string }>(
  document: T
) {
  const { _creationTime: creationTime, _id: id, ...fields } = document;
  return { ...fields, creationTime, id };
}

const convexTenantSchema = convexDocument
  .extend({
    displayName: z.string().optional(),
    paidUntil: z.number().optional(),
    phoneE164: z.string().optional(),
    photonAssignedNumber: z.string().optional(),
    status: z.enum(["active", "disabled"]),
    telegramChatId: z.string().optional(),
    telegramUserId: z.string().optional(),
    telegramUsername: z.string().optional(),
    tz: z.string().optional(),
  })
  .transform(renameSystemFields);

const convexPaymentSchema = convexDocument
  .extend({
    amountRub: z.number(),
    createdAt: z.number(),
    paidUntilAfter: z.number().optional(),
    status: z.enum(["pending", "succeeded", "canceled"]),
    tenantId: z.string().min(1),
    yookassaId: z.string().min(1),
  })
  .transform(renameSystemFields);

const convexOrderSchema = convexDocument
  .extend({
    createdAt: z.number().optional(),
    merchant: z.enum(["wb", "ozon", "other"]),
    merchantOrderId: z.string().min(1),
    pickup: z.string().optional(),
    priceRub: z.number(),
    status: z.enum(["placed", "cancelled", "unknown"]),
    tenantId: z.string().min(1),
    title: z.string(),
  })
  .transform(renameSystemFields);

const convexVaultItemSchema = convexDocument
  .extend({
    account: z.string(),
    createdAt: z.number(),
    handle: z.string().min(1),
    kind: z.enum(["login", "payment", "address", "contact"]),
    label: z.string(),
    origin: z.string().optional(),
    tenantId: z.string().min(1),
    updatedAt: z.number(),
  })
  .transform(renameSystemFields);

const convexVaultSecretSchema = convexDocument
  .extend({
    ciphertext: z.string().min(1),
    handle: z.string().min(1),
    tenantId: z.string().min(1),
    updatedAt: z.number(),
  })
  .transform(renameSystemFields);

export type ConvexTenant = z.infer<typeof convexTenantSchema>;
export type ConvexPayment = z.infer<typeof convexPaymentSchema>;
export type ConvexOrder = z.infer<typeof convexOrderSchema>;
export type ConvexVaultItem = z.infer<typeof convexVaultItemSchema>;
type ConvexVaultSecret = z.infer<typeof convexVaultSecretSchema>;

export interface ConvexExport {
  readonly orders: readonly ConvexOrder[];
  readonly payments: readonly ConvexPayment[];
  readonly tenants: readonly ConvexTenant[];
  readonly vaultItems: readonly ConvexVaultItem[];
  readonly vaultSecrets: readonly ConvexVaultSecret[];
}

export async function readConvexExport(
  directory: string
): Promise<ConvexExport> {
  const [tenants, payments, orders, vaultItems, vaultSecrets] =
    await Promise.all([
      readConvexTable(directory, "tenants", convexTenantSchema, true),
      readConvexTable(directory, "payments", convexPaymentSchema, false),
      readConvexTable(directory, "orders", convexOrderSchema, false),
      readConvexTable(directory, "vaultItems", convexVaultItemSchema, false),
      readConvexTable(
        directory,
        "vaultSecrets",
        convexVaultSecretSchema,
        false
      ),
    ]);
  return { orders, payments, tenants, vaultItems, vaultSecrets };
}

async function readConvexTable<T>(
  directory: string,
  table: string,
  schema: z.ZodType<T>,
  required: boolean
): Promise<T[]> {
  const documents = new URL(
    `${table}/documents.jsonl`,
    pathToFileURL(`${resolve(directory)}/`)
  );
  const contents = await readTableFile(documents, table, directory, required);
  if (contents === undefined) return [];

  return contents
    .split("\n")
    .map((line, index) => ({ line: line.trim(), number: index + 1 }))
    .filter((entry) => entry.line.length > 0)
    .map((entry) => decodeDocument(schema, table, entry.line, entry.number));
}

/** Reads one table file, or nothing when an optional table is not exported. */
async function readTableFile(
  documents: URL,
  table: string,
  directory: string,
  required: boolean
) {
  try {
    return await readFile(documents, "utf8");
  } catch (error) {
    const missing =
      error instanceof Error && "code" in error && error.code === "ENOENT";
    if (missing && !required) return undefined;
    throw new Error(
      `Could not read ${table}/documents.jsonl from the Convex export at ${directory}.`,
      { cause: error }
    );
  }
}

function decodeDocument<T>(
  schema: z.ZodType<T>,
  table: string,
  line: string,
  lineNumber: number
): T {
  const parsed = schema.safeParse(parseJsonLine(table, line, lineNumber));
  if (!parsed.success) {
    throw new Error(
      `${table}/documents.jsonl line ${String(lineNumber)} does not match the expected ${table} document: ${parsed.error.issues
        .map((issue) => `${issue.path.join(".")} ${issue.message}`)
        .join("; ")}`
    );
  }
  return parsed.data;
}

function parseJsonLine(table: string, line: string, lineNumber: number) {
  try {
    return z.json().parse(JSON.parse(line));
  } catch {
    throw new Error(
      `${table}/documents.jsonl line ${String(lineNumber)} is not valid JSON.`
    );
  }
}

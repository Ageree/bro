import { randomUUID } from "node:crypto";
import { and, asc, eq, sql } from "drizzle-orm";
import { domesticPhoneSchema } from "@shared/phone/policy";
import type { AccessScope } from "@shared/identity/access-scope";
import { env } from "@shared/environment";
import { db, phoneContacts } from "@db";

/** Contacts one workspace may keep: a book, not a database. */
const contactsLimit = 200;

/** Whether Bro's address book is on for the workspace (`CONTACTS_WORKSPACES`). */
export function contactsPilot(scope: Pick<AccessScope, "workspaceId">) {
  return (env.CONTACTS_WORKSPACES ?? []).some(
    (entry) => entry === "*" || entry === scope.workspaceId
  );
}

/** A name as lookups compare it: lower case, «ё» as «е», single spaces. */
function foldName(name: string) {
  return name
    .toLowerCase()
    .replaceAll("ё", "е")
    .replaceAll(/\s+/gu, " ")
    .trim();
}

/**
 * A full domestic +7 number from the way a person writes one («8 916 123-45-67»,
 * «+7 (916) 123 45 67»), or undefined when it is none.
 */
export function normalizeDomesticPhone(raw: string) {
  const digits = raw.replaceAll(/[\s().-]/gu, "");
  const full = /^8\d{10}$/u.test(digits)
    ? `+7${digits.slice(1)}`
    : /^7\d{10}$/u.test(digits)
      ? `+${digits}`
      : digits;
  const parsed = domesticPhoneSchema.safeParse(full);
  return parsed.success ? parsed.data : undefined;
}

function commonPrefix(left: string, right: string) {
  let length = 0;
  while (
    length < left.length &&
    length < right.length &&
    left[length] === right[length]
  )
    length += 1;
  return length;
}

/**
 * Two words are the same name when they are equal or differ only in a case
 * ending («маме» / «мама», «Саше» / «Саша»): a shared stem of at least three
 * letters that leaves at most two letters of the shorter word over.
 */
function sameWord(left: string, right: string) {
  if (left === right) return true;
  const shared = commonPrefix(left, right);
  return shared >= 3 && shared >= Math.min(left.length, right.length) - 2;
}

type Contact = typeof phoneContacts.$inferSelect;

function labelMatches(query: string, label: string) {
  const words = foldName(label).split(" ");
  return foldName(query)
    .split(" ")
    .every((word) => words.some((candidate) => sameWord(word, candidate)));
}

/** The contacts the person means by `query`: exact names and aliases first. */
export async function findContacts(
  scope: Pick<AccessScope, "workspaceId">,
  query: string
) {
  const rows = await db
    .select()
    .from(phoneContacts)
    .where(eq(phoneContacts.workspaceId, scope.workspaceId))
    .orderBy(asc(phoneContacts.name))
    .limit(contactsLimit);
  const folded = foldName(query);
  if (folded === "") return [];
  const labels = (row: Contact) => [row.name, ...row.aliases];
  const exact = rows.filter((row) =>
    labels(row).some((label) => foldName(label) === folded)
  );
  if (exact.length > 0) return exact;
  return rows.filter((row) =>
    labels(row).some((label) => labelMatches(query, label))
  );
}

export async function listContacts(scope: Pick<AccessScope, "workspaceId">) {
  return db
    .select()
    .from(phoneContacts)
    .where(eq(phoneContacts.workspaceId, scope.workspaceId))
    .orderBy(asc(phoneContacts.name))
    .limit(contactsLimit);
}

export type ContactInput = {
  readonly name: string;
  readonly aliases?: readonly string[];
  readonly phones: readonly string[];
  readonly note?: string | undefined;
  readonly familiar?: boolean | undefined;
};

/**
 * Saves a contact under its name: a second save of the same name replaces
 * the earlier one's numbers, aliases and note (the person corrects a number
 * by saying it again). Phones must already be normalized.
 */
export async function saveContact(
  scope: Pick<AccessScope, "workspaceId">,
  input: ContactInput
) {
  const searchKey = foldName(input.name);
  const values = {
    aliases: [...(input.aliases ?? [])],
    familiar: input.familiar ?? true,
    name: input.name.trim(),
    note: input.note ?? null,
    phones: [...input.phones],
    searchKey,
    updatedAt: new Date(),
  };
  return db.transaction(async (transaction) => {
    await transaction.execute(
      sql`select pg_advisory_xact_lock(hashtext(${`contacts:${scope.workspaceId}`}))`
    );
    const [known] = await transaction
      .select({ id: phoneContacts.id })
      .from(phoneContacts)
      .where(
        and(
          eq(phoneContacts.workspaceId, scope.workspaceId),
          eq(phoneContacts.searchKey, searchKey)
        )
      );
    if (known !== undefined) {
      const [row] = await transaction
        .update(phoneContacts)
        .set(values)
        .where(eq(phoneContacts.id, known.id))
        .returning();
      return row === undefined
        ? ({ kind: "missing" } as const)
        : ({ kind: "updated", row } as const);
    }
    const [{ total } = { total: 0 }] = await transaction
      .select({ total: sql<number>`count(*)::int` })
      .from(phoneContacts)
      .where(eq(phoneContacts.workspaceId, scope.workspaceId));
    if (total >= contactsLimit) return { kind: "full" } as const;
    const [row] = await transaction
      .insert(phoneContacts)
      .values({ ...values, id: randomUUID(), workspaceId: scope.workspaceId })
      .returning();
    if (row === undefined) throw new Error("The contact was not saved.");
    return { kind: "created", row } as const;
  });
}

/** Deletes the contact the name means, but only when exactly one matches. */
export async function deleteContact(
  scope: Pick<AccessScope, "workspaceId">,
  name: string
) {
  const found = await findContacts(scope, name);
  if (found.length === 0) return { kind: "none" } as const;
  const [only] = found;
  if (found.length > 1 || only === undefined)
    return { kind: "ambiguous", names: found.map((row) => row.name) } as const;
  await db
    .delete(phoneContacts)
    .where(
      and(
        eq(phoneContacts.workspaceId, scope.workspaceId),
        eq(phoneContacts.id, only.id)
      )
    );
  return { kind: "deleted", name: only.name } as const;
}

import { readdir, readFile } from "node:fs/promises";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as schema from "../schema";

// A fresh PGlite with every migration applied takes seconds.
vi.setConfig({ testTimeout: 30_000 });

const databases: PGlite[] = [];
const alice = { userId: "alice", workspaceId: "workspace:alice" };
const bob = { userId: "bob", workspaceId: "workspace:bob" };

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(databases.splice(0).map((database) => database.close()));
});

async function book() {
  vi.resetModules();
  const client = new PGlite();
  databases.push(client);
  await applyMigrations(client);
  // SAFETY: PGlite implements the query-builder surface these services use despite using a different Drizzle driver.
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- This test swaps only the driver while retaining the shared Drizzle schema and query-builder contract.
  const database = drizzle(client, { schema }) as never;
  const [Database, scope, service] = await Promise.all([
    import("@db"),
    import("@db/services/scope"),
    import("@db/services/contacts"),
  ]);
  vi.spyOn(Database, "db", "get").mockReturnValue(database);
  await scope.ensureScope(alice);
  await scope.ensureScope(bob);
  return service;
}

describe("address book", () => {
  it("finds a contact by name, alias and the case forms the person speaks in", async () => {
    const service = await book();
    await service.saveContact(alice, {
      aliases: ["мамочка"],
      name: "Мама",
      phones: ["+79161234567"],
    });
    await service.saveContact(alice, {
      name: "Саша с работы",
      phones: ["+79251112233"],
    });
    await service.saveContact(alice, {
      name: "Маша",
      phones: ["+79263334455"],
    });
    const names = async (query: string) =>
      (await service.findContacts(alice, query)).map((row) => row.name);
    expect(await names("маме")).toEqual(["Мама"]);
    expect(await names("МАМОЧКА")).toEqual(["Мама"]);
    expect(await names("Саше")).toEqual(["Саша с работы"]);
    expect(await names("Саше с работы")).toEqual(["Саша с работы"]);
    expect(await names("Машу")).toEqual(["Маша"]);
    expect(await names("папе")).toEqual([]);
  });

  it("treats ё and е alike and keeps workspaces apart", async () => {
    const service = await book();
    await service.saveContact(alice, {
      name: "Лёша",
      phones: ["+79161234567"],
    });
    expect(await service.findContacts(alice, "лёше")).toHaveLength(1);
    expect(await service.findContacts(alice, "Леша")).toHaveLength(1);
    expect(await service.findContacts(bob, "Леша")).toEqual([]);
  });

  it("replaces a contact saved again under the same name", async () => {
    const service = await book();
    const first = await service.saveContact(alice, {
      name: "Мама",
      phones: ["+79161234567"],
    });
    const second = await service.saveContact(alice, {
      name: "мама",
      phones: ["+79169998877"],
    });
    expect([first.kind, second.kind]).toEqual(["created", "updated"]);
    expect(await service.listContacts(alice)).toMatchObject([
      { phones: ["+79169998877"] },
    ]);
  });

  it("deletes only an unambiguous contact", async () => {
    const service = await book();
    await service.saveContact(alice, {
      name: "Саша",
      phones: ["+79161234567"],
    });
    await service.saveContact(alice, {
      name: "Саша с работы",
      phones: ["+79251112233"],
    });
    expect((await service.deleteContact(alice, "Саша")).kind).toBe("deleted");
    expect(await service.listContacts(alice)).toMatchObject([
      { name: "Саша с работы" },
    ]);
    await service.saveContact(alice, {
      name: "Сашка",
      phones: ["+79160000000"],
    });
    expect((await service.deleteContact(alice, "Саше")).kind).toBe("ambiguous");
    expect((await service.deleteContact(alice, "папа")).kind).toBe("none");
  });

  it("normalizes the numbers people write", async () => {
    const service = await book();
    expect(service.normalizeDomesticPhone("8 (916) 123-45-67")).toBe(
      "+79161234567"
    );
    expect(service.normalizeDomesticPhone("+7 916 123 45 67")).toBe(
      "+79161234567"
    );
    expect(service.normalizeDomesticPhone("+380501234567")).toBeUndefined();
    expect(service.normalizeDomesticPhone("112")).toBeUndefined();
  });
});

async function applyMigrations(database: PGlite) {
  const directory = new URL("../migrations/", import.meta.url);
  const names = (await readdir(directory))
    .filter((name) => name.endsWith(".sql"))
    .toSorted();
  /* oxlint-disable eslint/no-await-in-loop -- SQL migration statements must execute in file order. */
  for (const name of names) {
    const migration = await readFile(new URL(name, directory), "utf8");
    for (const statement of migration.split("--> statement-breakpoint")) {
      if (statement.trim()) await database.exec(statement);
    }
  }
  /* oxlint-enable eslint/no-await-in-loop */
}

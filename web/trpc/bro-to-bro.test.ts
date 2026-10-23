import { randomUUID } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as schema from "@db/schema";

// A fresh PGlite with every migration applied takes seconds.
vi.setConfig({ testTimeout: 60_000 });

const databases: PGlite[] = [];
const savely = {
  userId: "better-auth:savely",
  workspaceId: "workspace:savely",
};
const petya = { userId: "better-auth:petya", workspaceId: "workspace:petya" };
const masha = { userId: "better-auth:masha", workspaceId: "workspace:masha" };
const mandate = {
  goal: "Поужинать на выходных",
  details: "После врача в субботу свободен",
  window: null,
  durationMinutes: 90,
};

afterEach(async () => {
  vi.restoreAllMocks();
  vi.stubEnv("BRO_TO_BRO_WORKSPACES", "");
  await Promise.all(databases.splice(0).map((database) => database.close()));
});

/** Three people on a fresh database, and the cabinet's procedures as each. */
async function cabinet(pilot: string) {
  vi.resetModules();
  vi.stubEnv("BRO_TO_BRO_WORKSPACES", pilot);
  const client = new PGlite();
  databases.push(client);
  await applyMigrations(client);
  // SAFETY: PGlite implements the query-builder surface these services use despite using a different Drizzle driver.
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- This test swaps only the driver while retaining the shared Drizzle schema and query-builder contract.
  const database = drizzle(client, { schema }) as never;
  const Database = await import("@db");
  vi.spyOn(Database, "db", "get").mockReturnValue(database);
  const scope = await import("@db/services/scope");
  for (const each of [savely, petya, masha])
    // oxlint-disable-next-line eslint/no-await-in-loop -- Workspaces are created one by one, as people sign up.
    await scope.ensureScope(each);
  await client.exec(`
    INSERT INTO user_profiles (workspace_id, first_name) VALUES ('workspace:savely', 'Савелий');
    INSERT INTO "user" (id, name, email) VALUES ('petya', 'Пётр', 'petya@example.com');
  `);
  const { appRouter } = await import("@web/trpc/router");
  const links = await import("@db/services/bro-to-bro/links");
  const threads = await import("@db/services/bro-to-bro/threads");
  const steps = await import("@db/services/bro-to-bro/steps");
  return {
    as: (each: typeof savely) =>
      appRouter.createCaller({ origin: "https://example.com", scope: each })
        .broToBro,
    ...links,
    ...threads,
    ...steps,
  };
}

describe("the cabinet's Bro links", () => {
  it("links two people only through their own rows and the inviter's confirmation", async () => {
    const bro = await cabinet("workspace:savely,workspace:masha");

    // Petya is not in the pilot: he invites nobody.
    await expect(bro.as(petya).invite({ label: "" })).rejects.toMatchObject({
      code: "FORBIDDEN",
    });
    const invite = await bro.as(savely).invite({ label: "брат" });
    const web = new URL(invite.web);
    const token = web.searchParams.get("bro_invite") ?? "";
    expect(web.pathname).toBe("/workspace");
    await expect(bro.as(petya).acceptInvite({ token })).resolves.toEqual({
      inviterName: "Савелий",
    });
    await expect(bro.as(petya).acceptInvite({ token })).rejects.toMatchObject({
      code: "CONFLICT",
    });

    const [own] = await bro.listBroLinks(savely);
    const [theirs] = await bro.listBroLinks(petya);
    if (!own || !theirs) throw new Error("Both rows are written.");
    // The one who accepted sets up his own row but does not confirm it.
    await expect(
      bro.as(petya).confirm({ linkId: theirs.id })
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    await bro.as(petya).setCalendar({ linkId: theirs.id, allowed: false });
    // Nobody changes another person's row, linked or not.
    await expect(
      bro.as(savely).setShareNotes({ linkId: theirs.id, notes: "Адрес" })
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(
      bro.as(masha).remove({ linkId: own.id })
    ).rejects.toMatchObject({ code: "NOT_FOUND" });

    await bro.as(savely).confirm({ linkId: own.id });
    expect(await bro.listBroLinks(savely)).toMatchObject([
      { status: "active", label: "брат", peerCalendar: false },
    ]);
  });

  it("reads a thread only as one of its sides, and only that side's own words", async () => {
    const bro = await cabinet("*");
    const invite = await bro.as(savely).invite({ label: "брат" });
    await bro.as(petya).acceptInvite({
      token: new URL(invite.web).searchParams.get("bro_invite") ?? "",
    });
    const [own] = await bro.listBroLinks(savely);
    if (!own) throw new Error("The inviter has a link.");
    await bro.as(savely).confirm({ linkId: own.id });
    const started = await bro.startBroThread(savely, {
      linkId: own.id,
      mandate,
      reportTarget: null,
    });
    if (started.kind !== "started") throw new Error("The thread starts.");
    const [lease] = await bro.claimDueBroThreads({ limit: 1, leaseMs: 60_000 });
    const view = await bro.readBroThreadForSide(
      started.threadId,
      savely.workspaceId
    );
    if (!lease || !view?.link) throw new Error("The thread is due.");
    await bro.recordEnvoyStep(started.threadId, lease.leaseToken, {
      side: view.side,
      threadVersion: view.version,
      linkRevisions: view.link.revisions,
      outcome: {
        kind: "sent",
        message: { action: "message", body: "Савелий зовёт поужинать" },
      },
      outOfScope: [],
    });

    await expect(
      bro.as(savely).thread({ threadId: started.threadId })
    ).resolves.toMatchObject({
      own: { goal: mandate.goal, details: mandate.details },
      messages: [{ from: "self", body: "Савелий зовёт поужинать" }],
    });
    const theirs = await bro.as(petya).thread({ threadId: started.threadId });
    expect(theirs).toMatchObject({
      own: { goal: null, details: null },
      peer: { name: "Савелий", label: null },
      messages: [{ from: "peer", body: "Савелий зовёт поужинать" }],
    });
    // Neither Savely's errand nor how he calls Petya reaches Petya.
    expect(JSON.stringify(theirs)).not.toMatch(/врача|брат/u);
    await expect(
      bro.as(masha).thread({ threadId: started.threadId })
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("refuses what the cabinet never sends", async () => {
    const bro = await cabinet("*");
    await expect(
      bro.as(savely).setShareNotes({
        linkId: randomUUID(),
        notes: "а".repeat(2001),
      })
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    await expect(
      bro.as(savely).thread({ threadId: "thread-1" })
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    await expect(
      bro.as(savely).acceptInvite({ token: "../workspace" })
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
  });
});

async function applyMigrations(database: PGlite) {
  const directory = new URL("../../db/migrations/", import.meta.url);
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

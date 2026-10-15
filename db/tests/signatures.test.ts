import { randomUUID } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { PGlite } from "@electric-sql/pglite";
import { eq, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pglite";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as schema from "../schema";

const databases: PGlite[] = [];
const alice = { userId: "alice", workspaceId: "workspace:alice" };

afterEach(async () => {
  vi.doUnmock("@db");
  vi.doUnmock("@db/services/scope");
  await Promise.all(databases.splice(0).map((client) => client.close()));
});

async function signaturesDatabase() {
  vi.resetModules();
  const client = new PGlite();
  databases.push(client);
  const directory = new URL("../migrations/", import.meta.url);
  const names = (await readdir(directory))
    .filter((name) => name.endsWith(".sql"))
    .toSorted();
  const migrations = await Promise.all(
    names.map((name) => readFile(new URL(name, directory), "utf8"))
  );
  await migrations.reduce(async (previous, migration) => {
    await previous;
    await client.exec(migration);
  }, Promise.resolve());
  const database = drizzle(client, { schema });
  vi.doMock("@db", () => ({ ...schema, db: database }));
  vi.doMock("@db/services/scope", () => ({
    ensureScope: async (scope: typeof alice) => {
      await database
        .insert(schema.workspaces)
        .values({ id: scope.workspaceId })
        .onConflictDoNothing();
    },
  }));
  const samples = await import("@db/services/signatures/samples");
  const signings = await import("@db/services/signatures/signings");
  return { ...samples, ...signings, client, database };
}

const plan = {
  pages: 2,
  places: [
    {
      field: "bro_sign_signature_1",
      label: "Подпись",
      mark: true,
      pages: [1, 2],
      role: "signature" as const,
    },
  ],
};

function offer(fingerprint = "fingerprint:1", sourceSha256 = "a".repeat(64)) {
  return {
    dateText: "15.10.2026",
    expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
    fingerprint,
    language: "ru" as const,
    plan,
    prepareCallId: "call:prepare",
    question: "Ставлю твою сохранённую подпись на «anketa.pdf». Подписываю?",
    rootSessionId: "session:alice",
    shownAt: null,
    signatureId: randomUUID(),
    signatureKind: "image" as const,
    signaturePhotoPath: null,
    signaturePngSha256: null,
    signatureSource: "saved" as const,
    sourceBytes: 1000,
    sourceKind: "shared" as const,
    sourceName: "anketa.pdf",
    sourceRef: "https://example.com/eve/v1/sandbox-files/x/anketa.pdf?sig=s",
    sourceSha256,
    sourceShareId: "b".repeat(24),
  };
}

const claimOf = (id: string, callId: string) => ({
  callId,
  id,
  rootSessionId: "session:alice",
});

describe("the person's signature sample", () => {
  it("is stored sealed and read back, replaced and deleted", async () => {
    const store = await signaturesDatabase();
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]);
    const first = await store.saveSignatureSample(alice, {
      kind: "image",
      png,
    });
    expect(first.replaced).toBe(false);
    const [row] = await store.database.select().from(schema.personSignatures);
    expect(row?.encryptedValue).toMatch(/^v1\./u);
    expect(await store.readSignatureSample(alice)).toEqual({
      id: first.id,
      kind: "image",
      png,
    });
    const typed = await store.saveSignatureSample(alice, {
      kind: "typed",
      name: "Смирнова А.В.",
    });
    expect(typed.replaced).toBe(true);
    expect(await store.readSignatureSample(alice)).toMatchObject({
      font: "marck-script",
      name: "Смирнова А.В.",
    });
    expect(await store.deleteSignatureSample(alice)).toBe(true);
    expect(await store.readSignatureSummary(alice)).toBeNull();
  }, 30_000);

  it("does not open for another user, even moved to them", async () => {
    const store = await signaturesDatabase();
    await store.saveSignatureSample(alice, { kind: "typed", name: "Анна" });
    const mallory = { ...alice, userId: "mallory" };
    expect(await store.readSignatureSample(mallory)).toBeNull();
    await store.database
      .update(schema.personSignatures)
      .set({ userId: "mallory" });
    await expect(store.readSignatureSample(mallory)).rejects.toThrow(
      /authenticate/u
    );
  }, 30_000);
});

describe("signing offers", () => {
  it("keep one row per document and offer, and supersede an older offer for the same bytes", async () => {
    const store = await signaturesDatabase();
    const first = await store.prepareSigning(alice, offer());
    const again = await store.prepareSigning(alice, offer());
    expect(again.id).toBe(first.id);
    const newer = await store.prepareSigning(alice, offer("fingerprint:2"));
    expect(newer.id).not.toBe(first.id);
    expect(
      await store.readSigning(alice, "session:alice", first.id)
    ).toMatchObject({ status: "cancelled" });
  }, 30_000);

  it("revive a cancelled offer with what was asked and shown cleared", async () => {
    const store = await signaturesDatabase();
    const first = await store.prepareSigning(alice, offer());
    await store.markSigningAsked(first.id, {
      text: first.question,
      turn: "session:alice\nturn_1",
      verbatim: true,
    });
    await store.markSigningShown(first.id);
    expect(await store.cancelSigning(alice, "session:alice", first.id)).toBe(
      true
    );
    // A note of a delivery reaches only an open offer.
    await store.markSigningShown(first.id);
    expect(
      await store.readSigning(alice, "session:alice", first.id)
    ).toMatchObject({ askedVerbatim: true, status: "cancelled" });
    const revived = await store.prepareSigning(alice, offer());
    expect(revived).toMatchObject({
      askedAt: null,
      askedText: null,
      askedTurn: null,
      askedVerbatim: false,
      id: first.id,
      shownAt: null,
      status: "prepared",
    });
  }, 30_000);

  it("are claimed by one confirm at a time, and a hung claim is taken over after ten minutes", async () => {
    const store = await signaturesDatabase();
    const { id } = await store.prepareSigning(alice, offer());
    // The offer was quiet for half an hour before the first confirm.
    await store.database
      .update(schema.documentSignings)
      .set({ updatedAt: sql`now() - interval '30 minutes'` })
      .where(eq(schema.documentSignings.id, id));
    const racing = await Promise.all([
      store.claimSigning(alice, claimOf(id, "call:a")),
      store.claimSigning(alice, claimOf(id, "call:b")),
    ]);
    expect(racing.map(({ kind }) => kind).toSorted()).toEqual([
      "busy",
      "claimed",
    ]);
    const winner = racing.find(({ kind }) => kind === "claimed");
    const holder =
      winner?.kind === "claimed" ? (winner.row.confirmCallId ?? "") : "";
    const other = holder === "call:a" ? "call:b" : "call:a";
    // The holder's own retry keeps it.
    expect((await store.claimSigning(alice, claimOf(id, holder))).kind).toBe(
      "claimed"
    );
    await store.database
      .update(schema.documentSignings)
      .set({ updatedAt: sql`now() - interval '11 minutes'` })
      .where(eq(schema.documentSignings.id, id));
    expect((await store.claimSigning(alice, claimOf(id, other))).kind).toBe(
      "claimed"
    );
  }, 30_000);

  it("settle only under the claim's call, and a settled one stays signed", async () => {
    const store = await signaturesDatabase();
    const { id } = await store.prepareSigning(alice, offer());
    await store.claimSigning(alice, claimOf(id, "call:a"));
    const output = { bytes: 2000, sha256: "c".repeat(64), url: "https://x/y" };
    expect(
      await store.settleSigning({
        callId: "call:b",
        consentText: "да",
        id,
        output,
      })
    ).toBe(false);
    expect(
      await store.settleSigning({
        callId: "call:a",
        consentText: "да",
        id,
        output,
      })
    ).toBe(true);
    expect(
      await store.claimSigning(alice, claimOf(id, "call:c"))
    ).toMatchObject({
      kind: "signed",
      row: { outputUrl: "https://x/y", status: "signed" },
    });
    await store.releaseSigning({ callId: "call:a", id });
    expect(await store.prepareSigning(alice, offer())).toMatchObject({
      id,
      status: "signed",
    });
  }, 30_000);

  it("refuse a row that breaks a rule of the table", async () => {
    const store = await signaturesDatabase();
    const { id } = await store.prepareSigning(alice, offer());
    // One change per CHECK of the table.
    const broken = [
      "status = 'lost'",
      "source_share_id = NULL",
      "signature_source = 'photo'",
      "language = 'de'",
      "asked_at = now()",
      "status = 'signed', confirm_call_id = 'call:a'",
      "status = 'signing'",
    ];
    for (const change of broken) {
      // oxlint-disable-next-line eslint/no-await-in-loop -- One statement after another.
      await expect(
        store.client.query(
          `UPDATE document_signings SET ${change} WHERE id = $1`,
          [id]
        )
      ).rejects.toThrow(/check constraint/u);
    }
    await expect(
      store.client.query(
        "INSERT INTO person_signatures (workspace_id, id, user_id, kind, encrypted_value) VALUES ($1, $2, 'alice', 'typed', 'v1')",
        [alice.workspaceId, randomUUID()]
      )
    ).rejects.toThrow(/check constraint/u);
  }, 30_000);
});

import { readdir, readFile } from "node:fs/promises";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import type { HookContext } from "eve/hooks";
import type { z } from "zod";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as schema from "@db/schema";
import type { sendMessageOutputSchema } from "@shared/chat/message-delivery";

const pilot = vi.hoisted(() => ({ on: true }));
vi.mock("@agent/lib/signatures/pilot", () => ({
  signOfCaller: () => pilot.on,
}));

const databases: PGlite[] = [];
const scope = { userId: "user-1", workspaceId: "workspace:user-1" };
const shareId = "a1".repeat(12);

afterEach(async () => {
  pilot.on = true;
  vi.doUnmock("@db");
  vi.doUnmock("@db/services/scope");
  vi.stubEnv("SANDBOX_SIGNING_KEY", "");
  await Promise.all(databases.splice(0).map((client) => client.close()));
});

/** The hook over a database holding one open offer of this conversation. */
async function withOffer() {
  vi.resetModules();
  // Share links are signed with the sandbox key, read when modules load.
  vi.stubEnv("SANDBOX_SIGNING_KEY", "33".repeat(32));
  const client = new PGlite();
  databases.push(client);
  const directory = new URL("../../../db/migrations/", import.meta.url);
  const names = (await readdir(directory))
    .filter((name) => name.endsWith(".sql"))
    .toSorted();
  for (const name of names) {
    // oxlint-disable-next-line eslint/no-await-in-loop -- Migrations run in order.
    await client.exec(await readFile(new URL(name, directory), "utf8"));
  }
  const database = drizzle(client, { schema });
  vi.doMock("@db", () => ({ ...schema, db: database }));
  vi.doMock("@db/services/scope", () => ({
    ensureScope: async () => {
      await database
        .insert(schema.workspaces)
        .values({ id: scope.workspaceId })
        .onConflictDoNothing();
    },
  }));
  const signings = await import("@db/services/signatures/signings");
  const { sandboxFileLinkSignature } = await import("@agent/lib/sandbox/keys");
  const hook = (await import("@agent/hooks/sign-delivery")).default;
  const link = `https://example.com/eve/v1/sandbox-files/${shareId}/anketa.pdf?sig=${sandboxFileLinkSignature(`sandbox/files/${shareId}/anketa.pdf`)}`;
  const row = await signings.prepareSigning(scope, {
    dateText: "15.10.2026",
    expiresAt: new Date(Date.now() + 60 * 60 * 1000),
    fingerprint: "fingerprint:1",
    language: "ru",
    plan: {
      pages: 1,
      places: [
        {
          field: "signature",
          label: null,
          mark: false,
          pages: [1],
          role: "signature",
        },
      ],
    },
    prepareCallId: "call-prepare",
    question:
      "Ставлю твою сохранённую подпись на «anketa.pdf»: подпись — стр. 1. Это картинка подписи, а не электронная подпись (КЭП). Подписываю?",
    rootSessionId: "session-1",
    shown: false,
    signatureId: "6f6f5d78-641b-4c80-aacf-eec05af14e53",
    signatureKind: "image",
    signaturePhotoPath: null,
    signaturePngSha256: null,
    signatureSource: "saved",
    sourceBytes: 1000,
    sourceKind: "shared",
    sourceName: "anketa.pdf",
    sourceRef: link,
    sourceSha256: "a".repeat(64),
    sourceShareId: shareId,
  });
  const context = {
    agent: { name: "test-agent" },
    channel: { continuationToken: "conversation" },
    async getSandbox() {
      throw new Error("The hook needs no sandbox.");
    },
    getSkill() {
      throw new Error("The hook needs no skill.");
    },
    session: {
      auth: {
        current: {
          attributes: {
            conversationChannel: "eve",
            workspaceId: scope.workspaceId,
          },
          authenticator: "authjs",
          principalId: scope.userId,
          principalType: "user",
        },
        initiator: null,
      },
      id: "session-1",
      turn: { id: "turn_3", sequence: 3 },
    },
  } satisfies HookContext;
  return {
    link,
    question: row.question,
    read: async () => await signings.readSigning(scope, "session-1", row.id),
    async send(result: ReturnType<typeof toolResult>) {
      const handler = hook.events?.["action.result"];
      // SAFETY: the case builds only the fields of the event the hook reads.
      // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- A partial event stands in for the stream event.
      const event = { data: { result, status: "completed" } } as never;
      await handler?.(event, context);
    },
  };
}

/** What a send answers: the message that went out, or why it did not. */
type SentOutput =
  | z.input<typeof sendMessageOutputSchema>
  | { readonly reason: string; readonly skipped: true };

function toolResult(output: SentOutput) {
  return {
    callId: "call-send",
    isError: false,
    kind: "tool-result",
    output,
    toolName: "send_message",
  };
}

describe("noting what Bro's sends did to an open signing", () => {
  it(
    "marks the question asked in this turn and the file shown",
    { timeout: 60_000 },
    async () => {
      const offer = await withOffer();
      await offer.send(
        toolResult({
          attachments: [{ kind: "file", url: offer.link }],
          kind: "message",
          text: offer.question,
        })
      );
      const row = await offer.read();
      expect(row).toMatchObject({
        askedText: offer.question,
        askedTurn: "session-1\nturn_3",
        askedVerbatim: true,
      });
      // The file counts as seen with the question it came with (confirm
      // takes a file shown no later than the question).
      expect(row?.shownAt?.getTime()).toBeLessThanOrEqual(
        row?.askedAt?.getTime() ?? 0
      );

      // A later question of Bro's is what the person's «да» answers.
      await offer.send(toolResult({ kind: "message", text: "Что-то ещё?" }));
      expect(await offer.read()).toMatchObject({
        askedAt: null,
        askedVerbatim: false,
      });
    }
  );

  it(
    "changes nothing for a send that was skipped, or outside the pilot",
    { timeout: 60_000 },
    async () => {
      const offer = await withOffer();
      await offer.send(toolResult({ reason: "duplicate", skipped: true }));
      pilot.on = false;
      await offer.send(toolResult({ kind: "message", text: offer.question }));
      expect(await offer.read()).toMatchObject({
        askedAt: null,
        shownAt: null,
      });
    }
  );
});

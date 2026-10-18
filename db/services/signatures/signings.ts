import { randomUUID } from "node:crypto";
import { and, desc, eq, gt, lt, ne, or, sql } from "drizzle-orm";
import * as z from "zod";
import type { AccessScope } from "@shared/identity/access-scope";
import { db, documentSignings } from "@db";
import { ensureScope } from "@db/services/scope";

/**
 * What a signing puts where: the document's page count and its places, each
 * a form field by name with its role, the pages its widgets are on, the
 * label printed beside it and whether the task agent marked it
 * (`agent/lib/signatures/places.ts`); `dateGiven` when its date is the day
 * the person named, which stays on any later day (`sign_document`).
 */
const signingPlanSchema = z.object({
  dateGiven: z.boolean().optional(),
  pages: z.number().int().min(1).max(500),
  places: z
    .array(
      z.object({
        field: z.string().min(1).max(500),
        role: z.enum(["signature", "initials", "date"]),
        pages: z.array(z.number().int().min(1)).min(1).max(500),
        // Every distinct label of the field's widgets (`fieldLabel`).
        label: z.string().max(400).nullable(),
        mark: z.boolean(),
      })
    )
    .min(1)
    .max(40),
});

export type SigningPlan = z.infer<typeof signingPlanSchema>;

type NewSigning = typeof documentSignings.$inferInsert;

/** An offer as `sign_document prepare` makes it. */
type PreparedSigning = Pick<
  NewSigning,
  | "dateText"
  | "expiresAt"
  | "fingerprint"
  | "language"
  | "plan"
  | "prepareCallId"
  | "question"
  | "rootSessionId"
  | "signatureId"
  | "signatureKind"
  | "signaturePhotoPath"
  | "signaturePngSha256"
  | "signatureSource"
  | "sourceBytes"
  | "sourceKind"
  | "sourceName"
  | "sourceRef"
  | "sourceSha256"
  | "sourceShareId"
> & {
  /** The file reached the person before the offer: shown from now on. */
  readonly shown: boolean;
};

/** A claim that a hung confirm left behind is taken over after this. */
const claimTakeover = sql`now() - interval '10 minutes'`;

function ownedSignings(scope: AccessScope, rootSessionId: string) {
  return and(
    eq(documentSignings.workspaceId, scope.workspaceId),
    eq(documentSignings.userId, scope.userId),
    eq(documentSignings.rootSessionId, rootSessionId)
  );
}

function ownedSigning(scope: AccessScope, rootSessionId: string, id: string) {
  return and(eq(documentSignings.id, id), ownedSignings(scope, rootSessionId));
}

/**
 * Records one offer to sign one document in a conversation, one row per
 * document: an older offer still open for the same bytes, or with the same
 * question (a corrected version of the document reads the same, and one
 * «да» must answer one offer), is cancelled, and
 * the same offer again (the same fingerprint) is the row already there —
 * revived with its consent cleared when it was cancelled or expired, kept as
 * it is while it is live, and always once signed.
 */
export async function prepareSigning(
  scope: AccessScope,
  input: PreparedSigning
) {
  const { shown, ...offer } = input;
  const plan = signingPlanSchema.parse(offer.plan);
  // The database's clock, as the delivery notes use: shown no later than
  // the question asked after it.
  const shownAt = shown ? sql`now()` : null;
  await ensureScope(scope);
  await db
    .update(documentSignings)
    .set({ status: "cancelled", updatedAt: sql`now()` })
    .where(
      and(
        ownedSignings(scope, input.rootSessionId),
        or(
          eq(documentSignings.sourceSha256, input.sourceSha256),
          eq(documentSignings.question, input.question)
        ),
        eq(documentSignings.status, "prepared"),
        ne(documentSignings.fingerprint, input.fingerprint)
      )
    );
  const [written] = await db
    .insert(documentSignings)
    .values({
      ...offer,
      id: randomUUID(),
      plan,
      shownAt,
      userId: scope.userId,
      workspaceId: scope.workspaceId,
    })
    .onConflictDoUpdate({
      target: [
        documentSignings.workspaceId,
        documentSignings.rootSessionId,
        documentSignings.fingerprint,
      ],
      set: {
        askedAt: null,
        askedText: null,
        askedTurn: null,
        askedVerbatim: false,
        confirmCallId: null,
        consentText: null,
        expiresAt: input.expiresAt,
        outputBytes: null,
        outputSha256: null,
        outputUrl: null,
        prepareCallId: input.prepareCallId,
        question: input.question,
        shownAt,
        signedAt: null,
        status: "prepared",
        updatedAt: sql`now()`,
      },
      // A signed row is the audit of a signing: never reopened.
      setWhere: sql`${documentSignings.status} <> 'signed' AND (${documentSignings.status} = 'cancelled' OR ${documentSignings.expiresAt} < now())`,
    })
    .returning();
  if (written !== undefined) return written;
  const [existing] = await db
    .select()
    .from(documentSignings)
    .where(
      and(
        eq(documentSignings.workspaceId, scope.workspaceId),
        eq(documentSignings.rootSessionId, input.rootSessionId),
        eq(documentSignings.fingerprint, input.fingerprint)
      )
    )
    .limit(1);
  if (existing === undefined) throw new Error("The signing was not recorded.");
  return existing;
}

export async function readSigning(
  scope: AccessScope,
  rootSessionId: string,
  id: string
) {
  const [row] = await db
    .select()
    .from(documentSignings)
    .where(ownedSigning(scope, rootSessionId, id))
    .limit(1);
  return row;
}

/** The conversation's latest signings, newest first. */
export async function listSignings(
  scope: AccessScope,
  rootSessionId: string,
  limit = 5
) {
  return await db
    .select()
    .from(documentSignings)
    .where(ownedSignings(scope, rootSessionId))
    .orderBy(desc(documentSignings.createdAt))
    .limit(limit);
}

/** Offers of the conversation still waiting for the person's answer. */
export async function openSignings(scope: AccessScope, rootSessionId: string) {
  return await db
    .select()
    .from(documentSignings)
    .where(
      and(
        ownedSignings(scope, rootSessionId),
        eq(documentSignings.status, "prepared"),
        gt(documentSignings.expiresAt, sql`now()`)
      )
    )
    .orderBy(desc(documentSignings.createdAt))
    .limit(10);
}

const preparedRow = (id: string) =>
  and(eq(documentSignings.id, id), eq(documentSignings.status, "prepared"));

/** Bro's message that asked the person to sign reached them. */
export async function markSigningAsked(
  id: string,
  asked: { readonly text: string; readonly turn: string; verbatim: boolean }
) {
  await db
    .update(documentSignings)
    .set({
      askedAt: sql`now()`,
      askedText: sql`left(${asked.text}, 4000)`,
      askedTurn: asked.turn,
      askedVerbatim: asked.verbatim,
      updatedAt: sql`now()`,
    })
    .where(preparedRow(id));
}

/** A later question of Bro's is what the person's next words answer. */
export async function clearSigningAsked(id: string) {
  await db
    .update(documentSignings)
    .set({
      askedAt: null,
      askedText: null,
      askedTurn: null,
      askedVerbatim: false,
      updatedAt: sql`now()`,
    })
    .where(preparedRow(id));
}

/** The unsigned file reached the person. */
export async function markSigningShown(id: string) {
  await db
    .update(documentSignings)
    .set({
      shownAt: sql`coalesce(${documentSignings.shownAt}, now())`,
      updatedAt: sql`now()`,
    })
    .where(preparedRow(id));
}

/**
 * Takes the signing for one confirm call, in one statement: a live offer, or
 * one this call already holds (eve retries a step), or one whose confirm
 * hung for ten minutes. Otherwise it says why not.
 */
export async function claimSigning(
  scope: AccessScope,
  input: {
    readonly callId: string;
    readonly id: string;
    readonly rootSessionId: string;
  }
) {
  const [claimed] = await db
    .update(documentSignings)
    .set({
      confirmCallId: input.callId,
      status: "signing",
      updatedAt: sql`now()`,
    })
    .where(
      and(
        ownedSigning(scope, input.rootSessionId, input.id),
        gt(documentSignings.expiresAt, sql`now()`),
        or(
          eq(documentSignings.status, "prepared"),
          and(
            eq(documentSignings.status, "signing"),
            or(
              eq(documentSignings.confirmCallId, input.callId),
              lt(documentSignings.updatedAt, claimTakeover)
            )
          )
        )
      )
    )
    .returning();
  if (claimed !== undefined) return { kind: "claimed" as const, row: claimed };
  const row = await readSigning(scope, input.rootSessionId, input.id);
  if (row === undefined) return { kind: "missing" as const };
  if (row.status === "signed") return { kind: "signed" as const, row };
  if (row.status === "cancelled") return { kind: "cancelled" as const };
  if (row.status === "signing") return { kind: "busy" as const };
  return { kind: "expired" as const };
}

/** The signed file is stored: the claim of `callId` ends as signed. */
export async function settleSigning(input: {
  readonly callId: string;
  readonly consentText: string;
  readonly id: string;
  readonly output: {
    readonly bytes: number;
    readonly sha256: string;
    readonly url: string;
  };
}) {
  const [settled] = await db
    .update(documentSignings)
    .set({
      consentText: input.consentText,
      outputBytes: input.output.bytes,
      outputSha256: input.output.sha256,
      outputUrl: input.output.url,
      signedAt: sql`now()`,
      status: "signed",
      updatedAt: sql`now()`,
    })
    .where(
      and(
        eq(documentSignings.id, input.id),
        eq(documentSignings.status, "signing"),
        eq(documentSignings.confirmCallId, input.callId)
      )
    )
    .returning({ id: documentSignings.id });
  return settled !== undefined;
}

/** Nothing was signed: the claim of `callId` goes back to the offer. */
export async function releaseSigning(input: {
  readonly callId: string;
  readonly id: string;
}) {
  await db
    .update(documentSignings)
    .set({ confirmCallId: null, status: "prepared", updatedAt: sql`now()` })
    .where(
      and(
        eq(documentSignings.id, input.id),
        eq(documentSignings.status, "signing"),
        eq(documentSignings.confirmCallId, input.callId)
      )
    );
}

/** The person said no, or asked to drop the offer; only an open one goes. */
export async function cancelSigning(
  scope: AccessScope,
  rootSessionId: string,
  id: string
) {
  const [cancelled] = await db
    .update(documentSignings)
    .set({ status: "cancelled", updatedAt: sql`now()` })
    .where(
      and(
        ownedSigning(scope, rootSessionId, id),
        eq(documentSignings.status, "prepared")
      )
    )
    .returning({ id: documentSignings.id });
  return cancelled !== undefined;
}

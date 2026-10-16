import { sql } from "drizzle-orm";
import {
  boolean,
  check,
  foreignKey,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  unique,
  uuid,
} from "drizzle-orm/pg-core";
import type { SigningPlan } from "@db/services/signatures/signings";
import { workspaces } from "./workspaces";

const at = (name: string) =>
  timestamp(name, { mode: "date", precision: 3, withTimezone: true });

/**
 * The person's own signature sample, one per workspace (SIGN_WORKSPACES):
 * the PNG cut from the photo of their handwriting, or the name they typed
 * for a handwriting font, encrypted (`db/services/signatures/samples.ts`).
 * `id` is the version: a new one on every save, and each signing names the
 * version it was asked with.
 */
export const personSignatures = pgTable(
  "person_signatures",
  {
    workspaceId: text("workspace_id").primaryKey(),
    id: uuid("id").notNull(),
    userId: text("user_id").notNull(),
    kind: text("kind", { enum: ["image", "typed"] }).notNull(),
    encryptedValue: text("encrypted_value").notNull(),
    font: text("font", { enum: ["marck-script"] }),
    createdAt: at("created_at").defaultNow().notNull(),
    updatedAt: at("updated_at").defaultNow().notNull(),
  },
  (table) => [
    foreignKey({
      name: "person_signatures_workspace_id_fkey",
      columns: [table.workspaceId],
      foreignColumns: [workspaces.id],
    }).onDelete("cascade"),
    check(
      "person_signatures_kind_check",
      sql`${table.kind} IN ('image', 'typed')`
    ),
    check(
      "person_signatures_font_check",
      sql`(${table.kind} = 'typed') = (${table.font} IS NOT NULL)`
    ),
  ]
);

/**
 * One offer to sign one document in one conversation, and its audit: what
 * was signed (name, hash, size, places), with which signature version, the
 * question Bro asked and when it was delivered, whether the file reached
 * the person, their words, and the signed file.
 */
export const documentSignings = pgTable(
  "document_signings",
  {
    id: uuid("id").primaryKey(),
    workspaceId: text("workspace_id").notNull(),
    userId: text("user_id").notNull(),
    rootSessionId: text("root_session_id").notNull(),
    status: text("status", {
      enum: ["prepared", "signing", "signed", "cancelled"],
    })
      .notNull()
      .default("prepared"),
    fingerprint: text("fingerprint").notNull(),
    sourceKind: text("source_kind", {
      enum: ["attachment", "shared"],
    }).notNull(),
    // The staged path of the person's attachment, or the share link.
    sourceRef: text("source_ref").notNull(),
    sourceShareId: text("source_share_id"),
    sourceName: text("source_name").notNull(),
    sourceSha256: text("source_sha256").notNull(),
    sourceBytes: integer("source_bytes").notNull(),
    plan: jsonb("plan").$type<SigningPlan>().notNull(),
    signatureSource: text("signature_source", {
      enum: ["saved", "photo"],
    }).notNull(),
    // The saved sample's version, or the one the photo's sample gets.
    signatureId: uuid("signature_id").notNull(),
    signatureKind: text("signature_kind", {
      enum: ["image", "typed"],
    }).notNull(),
    signaturePhotoPath: text("signature_photo_path"),
    signaturePngSha256: text("signature_png_sha256"),
    dateText: text("date_text").notNull(),
    language: text("language", { enum: ["ru", "en"] }).notNull(),
    question: text("question").notNull(),
    prepareCallId: text("prepare_call_id").notNull(),
    askedAt: at("asked_at"),
    askedText: text("asked_text"),
    askedVerbatim: boolean("asked_verbatim").notNull().default(false),
    // `${sessionId}\n${turnId}` of the send that asked.
    askedTurn: text("asked_turn"),
    shownAt: at("shown_at"),
    confirmCallId: text("confirm_call_id"),
    consentText: text("consent_text"),
    outputUrl: text("output_url"),
    outputSha256: text("output_sha256"),
    outputBytes: integer("output_bytes"),
    expiresAt: at("expires_at").notNull(),
    createdAt: at("created_at").defaultNow().notNull(),
    updatedAt: at("updated_at").defaultNow().notNull(),
    signedAt: at("signed_at"),
  },
  (table) => [
    foreignKey({
      name: "document_signings_workspace_id_fkey",
      columns: [table.workspaceId],
      foreignColumns: [workspaces.id],
    }).onDelete("cascade"),
    unique("document_signings_fingerprint_uidx").on(
      table.workspaceId,
      table.rootSessionId,
      table.fingerprint
    ),
    index("document_signings_session_idx").on(
      table.workspaceId,
      table.rootSessionId,
      table.createdAt
    ),
    check(
      "document_signings_status_check",
      sql`${table.status} IN ('prepared', 'signing', 'signed', 'cancelled')`
    ),
    check(
      "document_signings_source_check",
      sql`${table.sourceKind} IN ('attachment', 'shared') AND (${table.sourceKind} = 'shared') = (${table.sourceShareId} IS NOT NULL)`
    ),
    check(
      "document_signings_signature_check",
      sql`${table.signatureSource} IN ('saved', 'photo') AND ${table.signatureKind} IN ('image', 'typed') AND (${table.signatureSource} = 'photo') = (${table.signaturePhotoPath} IS NOT NULL AND ${table.signaturePngSha256} IS NOT NULL) AND (${table.signatureSource} <> 'photo' OR ${table.signatureKind} = 'image')`
    ),
    check(
      "document_signings_language_check",
      sql`${table.language} IN ('ru', 'en')`
    ),
    check(
      "document_signings_asked_check",
      sql`(${table.askedAt} IS NULL) = (${table.askedTurn} IS NULL)`
    ),
    check(
      "document_signings_signed_check",
      sql`(${table.status} = 'signed') = (${table.outputUrl} IS NOT NULL AND ${table.signedAt} IS NOT NULL)`
    ),
    check(
      "document_signings_claim_check",
      sql`${table.status} NOT IN ('signing', 'signed') OR ${table.confirmCallId} IS NOT NULL`
    ),
  ]
);

export type DocumentSigning = typeof documentSignings.$inferSelect;

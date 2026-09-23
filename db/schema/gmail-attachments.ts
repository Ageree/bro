import { relations, sql } from "drizzle-orm";
import {
  check,
  foreignKey,
  index,
  integer,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { workspaceMemberships } from "./workspaces";

/**
 * A Gmail attachment copied into private Blob so it can travel as a private
 * artifact (`/artifacts/<id>`). One row per message part and session: asking
 * for the same attachment again in that session reuses the stored copy.
 */
export const gmailAttachmentArtifacts = pgTable(
  "gmail_attachment_artifacts",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    workspaceId: text("workspace_id").notNull(),
    createdByUserId: text("created_by_user_id").notNull(),
    rootSessionId: text("root_session_id").notNull(),
    gmailMessageId: text("gmail_message_id").notNull(),
    gmailPartId: text("gmail_part_id").notNull(),
    filename: text("filename").notNull(),
    mediaType: text("media_type").notNull(),
    byteSize: integer("byte_size").notNull(),
    contentHash: text("content_hash").notNull(),
    storagePathname: text("storage_pathname").notNull(),
    createdAt: timestamp("created_at", {
      mode: "date",
      precision: 3,
      withTimezone: true,
    })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    foreignKey({
      name: "gmail_attachment_artifacts_membership_fkey",
      columns: [table.workspaceId, table.createdByUserId],
      foreignColumns: [
        workspaceMemberships.workspaceId,
        workspaceMemberships.userId,
      ],
    }).onDelete("cascade"),
    check(
      "gmail_attachment_artifacts_byte_size_check",
      sql`${table.byteSize} > 0`
    ),
    uniqueIndex("gmail_attachment_artifacts_session_part_uidx").on(
      table.workspaceId,
      table.rootSessionId,
      table.gmailMessageId,
      table.gmailPartId
    ),
    index("gmail_attachment_artifacts_workspace_created_idx").on(
      table.workspaceId,
      table.createdAt.desc().nullsFirst()
    ),
  ]
);

export const gmailAttachmentArtifactsRelations = relations(
  gmailAttachmentArtifacts,
  ({ one }) => ({
    membership: one(workspaceMemberships, {
      fields: [
        gmailAttachmentArtifacts.workspaceId,
        gmailAttachmentArtifacts.createdByUserId,
      ],
      references: [
        workspaceMemberships.workspaceId,
        workspaceMemberships.userId,
      ],
    }),
  })
);

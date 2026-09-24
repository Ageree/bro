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
 * A Google Drive file copied into private Blob so it can travel as a private
 * artifact (`/artifacts/<id>`). One row per file version and session: reading
 * the same unchanged file again in that session reuses the stored copy.
 */
export const driveFileArtifacts = pgTable(
  "drive_file_artifacts",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    workspaceId: text("workspace_id").notNull(),
    createdByUserId: text("created_by_user_id").notNull(),
    rootSessionId: text("root_session_id").notNull(),
    driveFileId: text("drive_file_id").notNull(),
    driveVersion: text("drive_version").notNull(),
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
      name: "drive_file_artifacts_membership_fkey",
      columns: [table.workspaceId, table.createdByUserId],
      foreignColumns: [
        workspaceMemberships.workspaceId,
        workspaceMemberships.userId,
      ],
    }).onDelete("cascade"),
    check("drive_file_artifacts_byte_size_check", sql`${table.byteSize} > 0`),
    uniqueIndex("drive_file_artifacts_session_file_uidx").on(
      table.workspaceId,
      table.rootSessionId,
      table.driveFileId,
      table.driveVersion
    ),
    index("drive_file_artifacts_workspace_created_idx").on(
      table.workspaceId,
      table.createdAt.desc().nullsFirst()
    ),
  ]
);

export const driveFileArtifactsRelations = relations(
  driveFileArtifacts,
  ({ one }) => ({
    membership: one(workspaceMemberships, {
      fields: [
        driveFileArtifacts.workspaceId,
        driveFileArtifacts.createdByUserId,
      ],
      references: [
        workspaceMemberships.workspaceId,
        workspaceMemberships.userId,
      ],
    }),
  })
);

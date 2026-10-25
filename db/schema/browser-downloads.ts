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
 * A file a browser run downloaded for the person (a book, a ticket, a
 * statement), copied from its VM into private object storage so the run's
 * report can send it as a private artifact (`/artifacts/<id>`). One row per
 * run and file: a settle read twice stores it once.
 */
export const browserDownloadArtifacts = pgTable(
  "browser_download_artifacts",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    workspaceId: text("workspace_id").notNull(),
    createdByUserId: text("created_by_user_id").notNull(),
    rootSessionId: text("root_session_id").notNull(),
    browserRunId: text("browser_run_id").notNull(),
    /** The file's path in the run's session folder, `downloads/…`. */
    path: text("path").notNull(),
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
      name: "browser_download_artifacts_membership_fkey",
      columns: [table.workspaceId, table.createdByUserId],
      foreignColumns: [
        workspaceMemberships.workspaceId,
        workspaceMemberships.userId,
      ],
    }).onDelete("cascade"),
    check(
      "browser_download_artifacts_byte_size_check",
      sql`${table.byteSize} > 0`
    ),
    uniqueIndex("browser_download_artifacts_run_path_uidx").on(
      table.browserRunId,
      table.path
    ),
    index("browser_download_artifacts_workspace_created_idx").on(
      table.workspaceId,
      table.createdAt.desc().nullsFirst()
    ),
  ]
);

export const browserDownloadArtifactsRelations = relations(
  browserDownloadArtifacts,
  ({ one }) => ({
    membership: one(workspaceMemberships, {
      fields: [
        browserDownloadArtifacts.workspaceId,
        browserDownloadArtifacts.createdByUserId,
      ],
      references: [
        workspaceMemberships.workspaceId,
        workspaceMemberships.userId,
      ],
    }),
  })
);

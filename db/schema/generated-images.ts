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
 * A picture `generate_image` drew, kept in private Blob so it travels as a
 * private artifact (`/artifacts/<id>`). The idempotency key is the tool call,
 * so a replayed step hands back the picture it already drew.
 */
export const generatedImageArtifacts = pgTable(
  "generated_image_artifacts",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    workspaceId: text("workspace_id").notNull(),
    createdByUserId: text("created_by_user_id").notNull(),
    rootSessionId: text("root_session_id").notNull(),
    idempotencyKey: text("idempotency_key").notNull(),
    prompt: text("prompt").notNull(),
    model: text("model").notNull(),
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
      name: "generated_image_artifacts_membership_fkey",
      columns: [table.workspaceId, table.createdByUserId],
      foreignColumns: [
        workspaceMemberships.workspaceId,
        workspaceMemberships.userId,
      ],
    }).onDelete("cascade"),
    check(
      "generated_image_artifacts_byte_size_check",
      sql`${table.byteSize} > 0`
    ),
    uniqueIndex("generated_image_artifacts_workspace_idempotency_uidx").on(
      table.workspaceId,
      table.idempotencyKey
    ),
    index("generated_image_artifacts_workspace_created_idx").on(
      table.workspaceId,
      table.createdAt.desc().nullsFirst()
    ),
  ]
);

export const generatedImageArtifactsRelations = relations(
  generatedImageArtifacts,
  ({ one }) => ({
    membership: one(workspaceMemberships, {
      fields: [
        generatedImageArtifacts.workspaceId,
        generatedImageArtifacts.createdByUserId,
      ],
      references: [
        workspaceMemberships.workspaceId,
        workspaceMemberships.userId,
      ],
    }),
  })
);

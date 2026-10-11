import {
  boolean,
  foreignKey,
  index,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { workspaces } from "./workspaces";

/**
 * Bro's own address book of a workspace: the people the person calls by a
 * short name («мама», «Саша с работы») and the numbers Bro dials for them.
 * Names and aliases are stored as the person said them; `searchKey` is the
 * folded name, the one identity of a contact inside its workspace.
 */
export const phoneContacts = pgTable(
  "phone_contacts",
  {
    id: text("id").primaryKey(),
    workspaceId: text("workspace_id").notNull(),
    name: text("name").notNull(),
    aliases: text("aliases").array().notNull().default([]),
    phones: text("phones").array().notNull(),
    note: text("note"),
    // A person the user knows personally: the call greets them informally.
    familiar: boolean("familiar").notNull().default(true),
    searchKey: text("search_key").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "date" })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true, mode: "date" })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    uniqueIndex("phone_contacts_workspace_name_unique").on(
      table.workspaceId,
      table.searchKey
    ),
    index("phone_contacts_workspace_idx").on(table.workspaceId),
    foreignKey({
      columns: [table.workspaceId],
      foreignColumns: [workspaces.id],
    }).onDelete("cascade"),
  ]
);

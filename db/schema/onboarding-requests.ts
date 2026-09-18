import { index, pgTable, text, timestamp } from "drizzle-orm/pg-core";

/**
 * One row per phone number that asked the public landing for a Bro line. The
 * table is the whole memory of onboarding: the assigned Photon number is
 * replayed when the same phone asks again, the row count is the identity cap,
 * and the hashed caller address is the per-hour ceiling. No account exists
 * yet — the first inbound iMessage creates it.
 */
export const onboardingRequests = pgTable(
  "onboarding_requests",
  {
    phoneNumber: text("phone_number").primaryKey(),
    assignedPhoneNumber: text("assigned_phone_number").notNull(),
    // The caller's address is stored only as a digest: the ceiling needs to
    // recognise a repeat caller, not to identify one.
    ipHash: text("ip_hash").notNull(),
    createdAt: timestamp("created_at", {
      mode: "date",
      precision: 3,
      withTimezone: true,
    })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    index("onboarding_requests_caller_idx").on(table.ipHash, table.createdAt),
  ]
);

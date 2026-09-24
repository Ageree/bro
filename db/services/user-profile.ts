import { eq, sql } from "drizzle-orm";
import type { AccessScope } from "@shared/identity/access-scope";
import {
  emptyUserProfile,
  parseUserProfile,
  resolveTimeZone,
  userProfilePatchSchema,
  type UserProfile,
  type UserProfilePatch,
} from "@shared/user-profile/schema";
import { db, userProfiles } from "@db";
import { followScheduleTimeZone } from "./scheduled-agent-jobs";
import { ensureScope } from "./scope";

const selection = {
  addressLine1: userProfiles.addressLine1,
  addressLine2: userProfiles.addressLine2,
  city: userProfiles.city,
  countryCode: userProfiles.countryCode,
  dateOfBirth: userProfiles.dateOfBirth,
  email: userProfiles.email,
  firstName: userProfiles.firstName,
  lastName: userProfiles.lastName,
  phone: userProfiles.phone,
  postalCode: userProfiles.postalCode,
  region: userProfiles.region,
  timezone: userProfiles.timezone,
};

/** The workspace's own zone, defaulted, for a caller that needs nothing else. */
export async function readWorkspaceTimeZone(scope: AccessScope) {
  const rows = await db
    .select({ timezone: userProfiles.timezone })
    .from(userProfiles)
    .where(eq(userProfiles.workspaceId, scope.workspaceId))
    .limit(1);
  return resolveTimeZone(rows[0]?.timezone);
}

export async function readUserProfile(scope: AccessScope) {
  const rows = await db
    .select(selection)
    .from(userProfiles)
    .where(eq(userProfiles.workspaceId, scope.workspaceId))
    .limit(1);
  return parseUserProfile(rows[0] ?? emptyUserProfile);
}

export async function replaceUserProfile(
  scope: AccessScope,
  input: UserProfile
) {
  await ensureScope(scope);
  const profile = parseUserProfile(input);
  return writeUserProfile(scope, () => profile);
}

export async function patchUserProfile(
  scope: AccessScope,
  input: UserProfilePatch
) {
  const patch = userProfilePatchSchema.parse(input);
  await ensureScope(scope);
  return writeUserProfile(scope, (current) =>
    parseUserProfile({ ...current, ...patch })
  );
}

/**
 * Writes the profile `change` makes of the stored one. Profile changes run
 * one at a time per workspace (the lock is on the workspace, since a first
 * change has no row to lock), so a patch builds on the latest profile and
 * the schedules move from the zone actually replaced. The move commits with
 * the profile: a failure leaves neither, and a retry still finds the change.
 */
async function writeUserProfile(
  scope: AccessScope,
  change: (current: UserProfile) => UserProfile
) {
  return db.transaction(async (transaction) => {
    await transaction.execute(
      sql`SELECT pg_advisory_xact_lock(hashtextextended(${`user_profile:${scope.workspaceId}`}, 0))`
    );
    const [stored] = await transaction
      .select(selection)
      .from(userProfiles)
      .where(eq(userProfiles.workspaceId, scope.workspaceId))
      .limit(1);
    const profile = change(parseUserProfile(stored ?? emptyUserProfile));
    const updatedAt = new Date();
    await transaction
      .insert(userProfiles)
      .values({ ...profile, updatedAt, workspaceId: scope.workspaceId })
      .onConflictDoUpdate({
        target: userProfiles.workspaceId,
        set: { ...profile, updatedAt },
      });
    // «В 10 утра» means 10:00 wherever the person lives now.
    await followScheduleTimeZone(
      scope,
      resolveTimeZone(stored?.timezone),
      resolveTimeZone(profile.timezone),
      updatedAt,
      transaction
    );
    return profile;
  });
}

/** Whether Bro may write first; on until the person turns it off. */
export async function readProactiveMessages(scope: AccessScope) {
  const rows = await db
    .select({ proactiveMessages: userProfiles.proactiveMessages })
    .from(userProfiles)
    .where(eq(userProfiles.workspaceId, scope.workspaceId))
    .limit(1);
  return rows[0]?.proactiveMessages ?? true;
}

export async function setProactiveMessages(
  scope: AccessScope,
  enabled: boolean
) {
  await ensureScope(scope);
  const updatedAt = new Date();
  await db
    .insert(userProfiles)
    .values({
      proactiveMessages: enabled,
      updatedAt,
      workspaceId: scope.workspaceId,
    })
    .onConflictDoUpdate({
      target: userProfiles.workspaceId,
      set: { proactiveMessages: enabled, updatedAt },
    });
  return enabled;
}

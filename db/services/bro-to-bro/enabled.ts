import { and, eq, gt, isNull } from "drizzle-orm";
import { env } from "@shared/environment";
import { broInvites, broLinks, db } from "@db";
import { openedInviteMs } from "./invites";

/**
 * Where a workspace stands with Bro ↔ Bro (`BRO_TO_BRO_WORKSPACES`). Unset,
 * it is `off` for everyone; set, it is `on` for the workspaces it lists
 * (or all, with *) and for every workspace with an active link, so the
 * person who accepted an invite from the pilot gets the feature with the
 * link. A workspace that only opened an invite it may still accept is
 * `invited`: its Bro takes the person's yes (`bro_network accept_invite`)
 * and nothing else until the link is there.
 */
export async function broToBroStanding(
  workspaceId: string,
  now = new Date()
): Promise<"invited" | "off" | "on"> {
  const listed = env.BRO_TO_BRO_WORKSPACES ?? [];
  if (listed.length === 0) return "off";
  if (listed.some((entry) => entry === "*" || entry === workspaceId))
    return "on";
  const [[link], [invite]] = await Promise.all([
    db
      .select({ id: broLinks.id })
      .from(broLinks)
      .where(
        and(
          eq(broLinks.workspaceId, workspaceId),
          eq(broLinks.status, "active"),
          isNull(broLinks.removedAt)
        )
      )
      .limit(1),
    db
      .select({ id: broInvites.id })
      .from(broInvites)
      .where(
        and(
          eq(broInvites.openedByWorkspaceId, workspaceId),
          gt(broInvites.openedAt, new Date(now.getTime() - openedInviteMs)),
          gt(broInvites.expiresAt, now),
          isNull(broInvites.redeemedAt)
        )
      )
      .limit(1),
  ]);
  if (link !== undefined) return "on";
  return invite === undefined ? "off" : "invited";
}

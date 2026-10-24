import { broToBroStanding } from "@db/services/bro-to-bro/enabled";
import { listBroLinks } from "@db/services/bro-to-bro/links";
import { env } from "@shared/environment";
import type { AccessScope } from "@shared/identity/access-scope";

/**
 * Whether Bro ↔ Bro is on at all: unset, `BRO_TO_BRO_WORKSPACES` switches it
 * off for everyone, invites and links included.
 */
export function broToBroSwitchedOn() {
  return (env.BRO_TO_BRO_WORKSPACES ?? []).length > 0;
}

/**
 * What the cabinet lets a person do with Bro links, for the page and tRPC
 * alike. `on`: the feature is on for their workspace (the pilot, or an
 * active link), so they invite and manage everything. `linked`: all they
 * have is a link waiting for the inviter to confirm it (an invite they
 * accepted), which they may still set up or remove. `off`: nothing to
 * show — and so for someone who only opened an invite: they see its card
 * and «Принять» (`acceptInvite`), nothing else until the link is there.
 */
export async function broToBroAccess(
  scope: AccessScope
): Promise<"on" | "linked" | "off"> {
  if (!broToBroSwitchedOn()) return "off";
  if ((await broToBroStanding(scope.workspaceId)) === "on") return "on";
  return (await listBroLinks(scope)).length > 0 ? "linked" : "off";
}

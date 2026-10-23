import type { ToolContext } from "eve/tools";
import { usesBrowserVm } from "@agent/lib/browser-vm/backend";
import { recordLoginHandoffLink } from "@agent/lib/login-handoff/exact-link";
import {
  linkLifetimeMs,
  loginHandoffLink,
  newLinkId,
} from "@agent/lib/login-handoff/open";
import { scheduleOwner, scheduleReplyAnchor } from "@agent/lib/schedules/tools";
import { createLoginHandoff } from "@db/services/login-handoffs";

/**
 * A sign-in link for the conversation of this call, on a site already
 * checked by the caller (`site-login-link` against the person's words, the
 * Yandex tools against their own sign-in): the window opens on `openAt` and
 * may stay on `allowedDomains`. `busy` while another window of the person is
 * open; `no_browser` where the browser cannot show a window.
 */
export async function makeLoginHandoff(
  context: ToolContext,
  site: { readonly allowedDomains: readonly string[]; readonly domain: string },
  openAt: string
) {
  const owner = scheduleOwner(context);
  if (!(await usesBrowserVm({ ...owner.scope }))) {
    return { kind: "no_browser" as const };
  }
  const now = new Date();
  const id = newLinkId();
  const created = await createLoginHandoff(
    {
      allowedDomains: [...site.allowedDomains],
      conversationChannel: owner.conversation.conversationChannel,
      conversationId: owner.conversation.conversationId,
      createdByUserId: owner.scope.userId,
      domain: site.domain,
      expiresAt: new Date(now.getTime() + linkLifetimeMs),
      id,
      replyAnchorMessageId: scheduleReplyAnchor(context) ?? null,
      rootSessionId: context.session.id,
      siteUrl: openAt,
      workspaceId: owner.scope.workspaceId,
    },
    now
  );
  if (created.kind === "busy") return { kind: "busy" as const };
  const link = loginHandoffLink(id);
  // `send_message` puts this exact address into the text it sends
  // (`exact-link.ts`), so the model's copy of it does not matter.
  recordLoginHandoffLink(link);
  return { kind: "made" as const, link };
}

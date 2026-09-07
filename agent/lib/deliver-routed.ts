import {
  lastChannelOf,
  type HumanChannel,
} from "../../convex/lib/telegramPolicy.ts";
import { deliverHuman, type HumanTenant } from "./deliver-human.ts";
import {
  routingFromAuth,
  routingTenant,
  type AuthAttrs,
} from "./turn-routing.ts";

export function attrsFromSession(session: {
  auth?: {
    current?: { attributes?: AuthAttrs } | null;
    initiator?: { attributes?: AuthAttrs } | null;
  };
}): AuthAttrs {
  return session.auth?.current?.attributes ?? session.auth?.initiator?.attributes;
}

export function channelFromAuth(
  attrs: AuthAttrs,
  lastChannel?: string,
): HumanChannel {
  return routingFromAuth(attrs).channel ?? lastChannelOf(lastChannel);
}

export async function deliverHumanRouted(opts: {
  attrs?: AuthAttrs;
  tenant?: HumanTenant | null;
  conversationId?: string;
  text: string;
}): Promise<void> {
  const routing = routingFromAuth(opts.attrs);
  await deliverHuman({
    tenant: { ...opts.tenant, ...routingTenant(routing) },
    conversationId: opts.conversationId,
    text: opts.text,
    channel: routing.channel ?? lastChannelOf(opts.tenant?.lastChannel),
  });
}

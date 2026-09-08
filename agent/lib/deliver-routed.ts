import {
  lastChannelOf,
  type HumanChannel,
} from "../../convex/lib/telegramPolicy.ts";
import { deliverHuman, type HumanTenant } from "./deliver-human.ts";
import {
  routingFromAuth,
  routingPhone,
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
  principalId?: string | null;
}): Promise<void> {
  const routing = routingFromAuth(opts.attrs);
  const phone =
    routingPhone(routing, opts.principalId) ?? opts.tenant?.phoneE164;
  await deliverHuman({
    tenant: {
      ...opts.tenant,
      ...routingTenant(routing),
      ...(phone ? { phoneE164: phone } : {}),
    },
    conversationId: opts.conversationId,
    text: opts.text,
    channel: routing.channel ?? lastChannelOf(opts.tenant?.lastChannel),
  });
}

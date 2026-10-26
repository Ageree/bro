import type { SessionAuthContext } from "eve/context";
import type { z } from "zod";
import { scopeFromPrincipal } from "@agent/lib/principal-scope";
import type { sendMessageOutputSchema } from "@shared/chat/message-delivery";
import type { Card } from "@shared/cards/schema";
import { brandLink, partnerLinks, partnerLinksPilot } from "./travelpayouts";

/**
 * Bro's links to travel brands, put as partner links where they go out:
 * the text and the link of a `send_message`, and the links of a card. Bro and
 * its history keep the brand's own address; only what the person taps
 * changes.
 */

type SentMessage = z.infer<typeof sendMessageOutputSchema>;

/** An address in text: up to a space, a bracket or a quote. */
const addressPattern = /https:\/\/[^\s<>()[\]"'«»]+/gu;
const trailingPunctuation = /[.,;:!?]+$/u;

function addressesIn(text: string) {
  return [...text.matchAll(addressPattern)].map(([address]) =>
    address.replace(trailingPunctuation, "")
  );
}

function swapAddresses(text: string, links: ReadonlyMap<string, string>) {
  return text.replaceAll(addressPattern, (address) => {
    const punctuation = trailingPunctuation.exec(address)?.[0] ?? "";
    const core = address.slice(0, address.length - punctuation.length);
    return (links.get(core) ?? core) + punctuation;
  });
}

/** The workspace a person's auth names; none for any other caller. */
function workspaceOf(auth: SessionAuthContext | null | undefined) {
  if (auth?.principalType !== "user") return undefined;
  try {
    return scopeFromPrincipal(auth);
  } catch {
    // A send never fails on the links: it goes out as written.
    return undefined;
  }
}

/**
 * The message with its brand links as partner links, or nothing to wait for
 * when the workspace is not in the pilot or the message links no brand: the
 * send then goes out at once, as before.
 */
export function messageWithPartnerLinks<Message extends SentMessage>(
  message: Message,
  auth: SessionAuthContext | null | undefined
): Promise<Message> | undefined {
  const scope = workspaceOf(auth);
  if (scope === undefined || !partnerLinksPilot(scope)) return undefined;
  const addresses =
    message.kind === "link" ? [message.url] : addressesIn(message.text ?? "");
  if (!addresses.some(brandLink)) return undefined;
  return partnerLinks(addresses, "message").then((links) => {
    if (links.size === 0) return message;
    if (message.kind === "link") {
      return { ...message, url: links.get(message.url) ?? message.url };
    }
    return message.text === undefined
      ? message
      : { ...message, text: swapAddresses(message.text, links) };
  });
}

/** What a row or an option shows behind «Подробнее», its page among it. */
type More = NonNullable<
  Extract<Card["blocks"][number], { type: "choice" }>["options"][number]["more"]
>;

/** The card with every link its rows, options and buttons open changed by `swap`. */
function withCardLinks(card: Card, swap: (address: string) => string): Card {
  const moreOf = (more: More) =>
    more.href === undefined ? more : { ...more, href: swap(more.href) };
  return {
    ...card,
    actions: card.actions.map((action) =>
      "href" in action ? { ...action, href: swap(action.href) } : action
    ),
    blocks: card.blocks.map((block) => {
      if (block.type === "list") {
        return {
          ...block,
          rows: block.rows.map((row) => {
            const linked = { ...row };
            if (row.href !== undefined) linked.href = swap(row.href);
            if (row.more !== undefined) linked.more = moreOf(row.more);
            return linked;
          }),
        };
      }
      if (block.type === "choice") {
        return {
          ...block,
          options: block.options.map((option) =>
            option.more === undefined
              ? option
              : { ...option, more: moreOf(option.more) }
          ),
        };
      }
      return block;
    }),
  };
}

/**
 * The card with its brand links as partner links, before it is kept: its
 * page then opens them as it opens any link. Outside the pilot, or with no
 * brand link, the card itself.
 */
export async function cardWithPartnerLinks(
  card: Card,
  scope: { readonly workspaceId: string }
): Promise<Card> {
  if (!partnerLinksPilot(scope)) return card;
  const addresses: string[] = [];
  withCardLinks(card, (address) => {
    addresses.push(address);
    return address;
  });
  if (!addresses.some(brandLink)) return card;
  const links = await partnerLinks(addresses, "card");
  return links.size === 0
    ? card
    : withCardLinks(card, (address) => links.get(address) ?? address);
}

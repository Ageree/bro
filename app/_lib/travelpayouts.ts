/**
 * Travelpayouts Drive, the snippet by which Travelpayouts confirms that
 * brobro.tech is the owner's (it reads it from the head of the page the
 * server sends). It is someone else's script on the site's origin, so only
 * the public pages that hold nothing of a person carry it: not the chat, the
 * cabinet, sign-in, a payment's or a card's page. `proxy.ts` names such a
 * page to the root layout with this request header.
 */
export const travelpayoutsDriveHeader = "x-bro-travelpayouts-drive";

export const travelpayoutsDrivePages: ReadonlySet<string> = new Set([
  "/",
  "/oferta",
  "/privacy",
]);

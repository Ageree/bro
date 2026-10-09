import { backgroundTurnMarker } from "@shared/chat/background-turn";

/** How a handoff ended, as far as the person's page shows. */
export type HandoffEnding =
  | { readonly kind: "done"; readonly signedIn: boolean | null }
  | { readonly kind: "expired" }
  | { readonly kind: "failed" };

/** What the page showed when the person said they were through. */
export function looksSignedIn(page: {
  readonly allowed: boolean;
  readonly passwordField: boolean | null;
  readonly url: string;
}) {
  if (!page.allowed || page.passwordField === true) return false;
  // Still on the sign-in page of the site, a form with no password field
  // (a phone number, a code) as much as any.
  const path = URL.parse(page.url)?.pathname ?? "";
  if (/log[-_]?in|sign[-_]?in|auth|passport|register/iu.test(path)) {
    return false;
  }
  return page.passwordField === false ? true : null;
}

const instructions = {
  expired:
    "The window closed before the person said they were through, so nothing was signed in. Say so plainly and offer to send a new link if they want to try again.",
  failed:
    "The window could not be kept open (the browser had trouble), so nothing was signed in. Say so plainly and offer to send a new link.",
  "not-signed-in":
    "The person said they were through, but the page still shows a sign-in form, so it may not have worked. Say so, and offer a new link if they want to try again.",
  signed:
    "The person said they were through, and the page no longer shows a sign-in form. Say that Bro's browser should now stay signed in there for later errands (a site may still end a session on its own), and ask what they want done there.",
  unknown:
    "The person said they were through, but the page could not be checked. Say that Bro will see on the next errand whether the sign-in held.",
} as const;

/**
 * The message that reports the end of a handoff into the conversation the
 * link was asked for in. It names the site Bro itself chose and what the
 * page showed as a yes or a no: no page text, and nothing the page wrote.
 */
export function loginHandoffReport(domain: string, ending: HandoffEnding) {
  const instruction =
    ending.kind === "done"
      ? ending.signedIn === true
        ? instructions.signed
        : ending.signedIn === false
          ? instructions["not-signed-in"]
          : instructions.unknown
      : instructions[ending.kind];
  return [
    backgroundTurnMarker,
    `Sign-in result. The person was signing in to ${domain} themselves, in a live view of Bro's browser, from a link Bro sent. This is Bro's own note, not the person's message or permission: report it briefly in Russian, and do not start an errand, call a tool but send_message, or ask for a password or code. ${instruction}`,
  ].join("\n\n");
}

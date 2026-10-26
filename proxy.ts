import { NextResponse, type NextRequest } from "next/server";
import {
  travelpayoutsDriveHeader,
  travelpayoutsDrivePages,
} from "@web/auth/travelpayouts";
import { getAuthSession } from "@db/services/auth/session";

/**
 * The request on to its page, telling the root layout whether the page
 * carries Travelpayouts Drive (`web/auth/travelpayouts.ts`). A visitor's own
 * header of that name is dropped.
 */
function onward(request: NextRequest) {
  const headers = new Headers(request.headers);
  headers.delete(travelpayoutsDriveHeader);
  if (travelpayoutsDrivePages.has(request.nextUrl.pathname)) {
    headers.set(travelpayoutsDriveHeader, "1");
  }
  return NextResponse.next({ request: { headers } });
}

export async function proxy(request: NextRequest) {
  const pathname = request.nextUrl.pathname;
  if (
    pathname === "/sign-in" ||
    // The public landing and its offer page. The landing asks for nothing
    // and provisions nothing: it deep-links into iMessage, and the first
    // message on that line creates the account.
    pathname === "/" ||
    pathname === "/oferta" ||
    pathname === "/privacy" ||
    // YooKassa signs nothing this proxy could check. The route trusts only the
    // payment id in the body and re-fetches the payment itself.
    pathname === "/api/yookassa" ||
    // The owner's cost report checks its own bearer token.
    pathname === "/api/usage-costs" ||
    pathname === "/api/phone/initiation" ||
    pathname === "/api/phone/post-call" ||
    pathname.startsWith("/api/auth/") ||
    // The VM's watchdog and a release's switch ask without a session; off
    // the VM the route is a 404 that asks the database nothing.
    pathname === "/api/health" ||
    pathname === "/eve/v1/health" ||
    // Provider webhooks verify their own signatures inside the channel.
    pathname === "/eve/v1/browser-use" ||
    // The code sandbox's tool router checks the bearer token sandboxd adds,
    // and a shared file's link carries its own signature: Telegram and
    // iMessage deliveries fetch it without the person's cookie.
    pathname === "/eve/v1/sandbox-tools" ||
    // The sign-in window opened from a link in a chat: the person may not be
    // signed in to the web app, the link's id is the secret, and each
    // route checks the device that took it.
    pathname.startsWith("/handoff/") ||
    pathname.startsWith("/eve/v1/login-handoff/") ||
    // A card payment's page from a link in a chat, and where the person's
    // bank sends them back: the link's HMAC is the secret, and only the
    // press of «Оплатить» on the page pays (db/services/yoomoney/card.ts).
    pathname.startsWith("/pay/") ||
    pathname.startsWith("/api/yoomoney/pay/") ||
    // Connecting the wallet from a chat, opened in Telegram as much as in a
    // browser signed in: the link opens the page, and the page acts only
    // for a device that proved it is the person's — the cabinet's session
    // or Telegram's signed data — which YooMoney's callback then checks
    // too (db/services/yoomoney/onboarding.ts).
    pathname.startsWith("/yoomoney/") ||
    pathname.startsWith("/api/yoomoney/onboarding/") ||
    // A card Bro sent to a chat, opened as a Mini App in Telegram, and its
    // photos (shared/cards/photos.ts): the link's id is the secret, the page
    // shows the card, and its answer is taken only from the Telegram user it
    // was sent to, whom Telegram's signed launch data names
    // (db/services/cards.ts). The page then asks
    // Bro to carry on at once; that door takes nothing and only hurries
    // answers already kept (agent/channels/card-answers.ts).
    pathname.startsWith("/card/") ||
    pathname.startsWith("/api/cards/") ||
    pathname === "/eve/v1/card-answers" ||
    pathname === "/api/yoomoney/callback" ||
    pathname.startsWith("/eve/v1/sandbox-files/") ||
    pathname === "/eve/v1/dev/schedules/dynamic"
  ) {
    return onward(request);
  }

  if (await getAuthSession(request.headers)) return onward(request);

  const signInUrl = new URL("/sign-in", request.url);
  signInUrl.searchParams.set(
    "callbackUrl",
    `${request.nextUrl.pathname}${request.nextUrl.search}`
  );
  return NextResponse.redirect(signInUrl);
}

// Everything static the public pages need is excluded here, not allowed in
// the body above: a request the matcher catches is redirected to /sign-in,
// and that is what once hid the hero film and the og image, both of which
// live under /brand, and the tab and home-screen icons Next serves from the
// root (`app/icon.svg`, `app/apple-icon.png`) from search and signed-out tabs,
// and robots.txt, which a crawler got as the sign-in page.
export const config = {
  matcher: [
    "/((?!_next/static|_next/image|brand|fonts|favicon.ico|icon.svg|apple-icon.png|robots.txt|sitemap.xml).*)",
  ],
};

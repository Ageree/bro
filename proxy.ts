import { NextResponse, type NextRequest } from "next/server";
import { getAuthSession } from "@db/services/auth/session";

export async function proxy(request: NextRequest) {
  const pathname = request.nextUrl.pathname;
  if (
    pathname === "/sign-in" ||
    // The public landing and its offer page. The landing asks for nothing
    // and provisions nothing: it deep-links into iMessage, and the first
    // message on that line creates the account.
    pathname === "/" ||
    pathname === "/oferta" ||
    // YooKassa signs nothing this proxy could check. The route trusts only the
    // payment id in the body and re-fetches the payment itself.
    pathname === "/api/yookassa" ||
    // The owner's cost report checks its own bearer token.
    pathname === "/api/usage-costs" ||
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
    pathname.startsWith("/eve/v1/sandbox-files/") ||
    pathname === "/eve/v1/dev/schedules/dynamic"
  ) {
    return NextResponse.next();
  }

  if (await getAuthSession(request.headers)) return NextResponse.next();

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
// live under /brand.
export const config = {
  matcher: ["/((?!_next/static|_next/image|brand|fonts|favicon.ico).*)"],
};

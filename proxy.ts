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
    pathname.startsWith("/api/auth/") ||
    pathname === "/eve/v1/health" ||
    // Provider webhooks verify their own signatures inside the channel.
    pathname.startsWith("/webhooks/") ||
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

import { NextResponse, type NextRequest } from "next/server";
import { getAuthSession } from "@db/services/auth/session";

export async function proxy(request: NextRequest) {
  const pathname = request.nextUrl.pathname;
  if (
    pathname === "/sign-in" ||
    // The public landing, its offer page and the onboarding endpoint behind
    // its phone form. Onboarding hands out an iMessage line; the first message
    // on that line, not this proxy, creates the account.
    pathname === "/" ||
    pathname === "/oferta" ||
    pathname === "/api/access" ||
    // YooKassa signs nothing this proxy could check. The route trusts only the
    // payment id in the body and re-fetches the payment itself.
    pathname === "/api/yookassa" ||
    pathname.startsWith("/api/auth/") ||
    pathname === "/eve/v1/health" ||
    pathname.startsWith("/internal/scheduled-run/") ||
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

export const config = {
  matcher: ["/((?!_next/static|_next/image|fonts|favicon.ico).*)"],
};

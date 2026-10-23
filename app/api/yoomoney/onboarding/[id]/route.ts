import { cookies } from "next/headers";
import { NextResponse } from "next/server";
import * as z from "zod";
import {
  checkYoomoneyOnboardingCard,
  claimYoomoneyOnboardingDevice,
  finishYoomoneyOnboarding,
  onYoomoneyOnboardingDevice,
  readYoomoneyOnboardingByLink,
  startYoomoneyOnboardingConsent,
  yoomoneyOnboardingCookie,
} from "@db/services/yoomoney/onboarding";
import { applicationOrigin } from "@shared/environment/origin";
import { YoomoneyError } from "@shared/yoomoney/api";
import {
  requireRequestScope,
  UnauthenticatedError,
} from "@web/auth/request-scope";
import { telegramWebAppUser } from "@web/auth/telegram-web-app";

const formSchema = z.object({
  t: z.string().max(100),
  action: z.enum(["start", "check", "skip"]),
  initData: z.string().max(8192).optional(),
});

/** The person's session in the cabinet, when this browser has one. */
async function sessionUser() {
  try {
    return (await requireRequestScope()).userId;
  } catch (error) {
    if (error instanceof UnauthenticatedError) return undefined;
    throw error;
  }
}

/**
 * The buttons of the onboarding page (`app/(public)/yoomoney/[id]`), only
 * from its own origin: «Подключить ЮMoney» starts YooMoney's consent,
 * «Проверить» looks for a card linked to the wallet, «Пропустить» leaves it
 * without one. The first press takes the page for this device, once it
 * proves it is the person's (`db/services/yoomoney/onboarding.ts`).
 */
export async function POST(
  request: Request,
  { params }: RouteContext<"/api/yoomoney/onboarding/[id]">
) {
  const { id } = await params;
  const origin = applicationOrigin();
  if (request.headers.get("origin") !== origin)
    return new NextResponse(null, { status: 403 });
  const form = formSchema.safeParse(
    Object.fromEntries((await request.formData()).entries())
  );
  if (!form.success) return new NextResponse(null, { status: 400 });
  const page = new URL(`/yoomoney/${id}`, origin);
  page.searchParams.set("t", form.data.t);
  const headers = { "Cache-Control": "no-store" };
  const back = (notice?: string) => {
    if (notice !== undefined) page.searchParams.set("e", notice);
    return NextResponse.redirect(page, { headers, status: 303 });
  };
  const onboarding = await readYoomoneyOnboardingByLink(id, form.data.t);
  if (!onboarding) return back();
  let claimed: string | undefined;
  if (
    !onYoomoneyOnboardingDevice(
      onboarding,
      (await cookies()).get(yoomoneyOnboardingCookie)?.value
    )
  ) {
    const userId = await sessionUser();
    const telegramUserId = telegramWebAppUser(form.data.initData ?? "", {
      notBefore: onboarding.createdAt,
    });
    claimed =
      userId === undefined
        ? undefined
        : await claimYoomoneyOnboardingDevice(onboarding, {
            kind: "session",
            userId,
          });
    claimed ??=
      telegramUserId === undefined
        ? undefined
        : await claimYoomoneyOnboardingDevice(onboarding, {
            kind: "telegram",
            telegramUserId,
          });
    if (claimed === undefined) return back("who");
  }
  let response: NextResponse;
  try {
    if (form.data.action === "start") {
      response =
        onboarding.connectedAt === null
          ? NextResponse.redirect(
              await startYoomoneyOnboardingConsent(onboarding, origin),
              { headers, status: 303 }
            )
          : back();
    } else if (onboarding.connectedAt === null) {
      response = back();
    } else if (form.data.action === "skip") {
      await finishYoomoneyOnboarding(onboarding.id);
      response = back();
    } else {
      const checked = await checkYoomoneyOnboardingCard(onboarding);
      response = !checked.connected
        ? back("gone")
        : checked.cards.length === 0
          ? back("no_card")
          : back();
    }
  } catch (error) {
    console.warn("[yoomoney] onboarding failed", {
      action: form.data.action,
      code: error instanceof YoomoneyError ? error.code : undefined,
      name: error instanceof Error ? error.name : "unknown",
    });
    response = back("failed");
  }
  if (claimed !== undefined) {
    response.cookies.set(yoomoneyOnboardingCookie, claimed, {
      httpOnly: true,
      maxAge: 2 * 60 * 60,
      path: "/",
      // Lax: YooMoney sends the person back by a top-level GET, which
      // carries it; another site's form POST does not.
      sameSite: "lax",
      secure: origin.startsWith("https:"),
    });
  }
  return response;
}

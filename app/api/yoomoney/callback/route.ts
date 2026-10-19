import { cookies } from "next/headers";
import { NextResponse } from "next/server";
import * as z from "zod";
import {
  cancelYoomoneyAuthorization,
  finishYoomoneyAuthorization,
} from "@db/services/yoomoney/connection";
import {
  markYoomoneyOnboardingConnected,
  yoomoneyOnboardingCookie,
  yoomoneyOnboardingLink,
  yoomoneyOnboardingOfState,
} from "@db/services/yoomoney/onboarding";
import { applicationOrigin } from "@shared/environment/origin";
import { YoomoneyError } from "@shared/yoomoney/api";
import {
  requireRequestScope,
  UnauthenticatedError,
} from "@web/auth/request-scope";

const stateSchema = z.string().regex(/^[\w-]{43}$/u);
const callbackSchema = z.object({
  code: z.string().min(1).max(4096),
  state: stateSchema,
});

/**
 * Where YooMoney sends the person back: with `code` after consent, with
 * `error=access_denied` after a refusal; the state rides in the query of
 * the Redirect URI (`db/services/yoomoney/connection.ts`). A consent
 * started on an onboarding's page goes back to that page, and the device
 * that proved itself there stands for the cabinet's session.
 */
export async function GET(request: Request) {
  let url = new URL("/workspace", applicationOrigin());
  url.searchParams.set("yoomoney", "failed");
  const query = new URL(request.url).searchParams;
  const callback = callbackSchema.safeParse({
    code: query.get("code"),
    state: query.get("state"),
  });
  const state = stateSchema.safeParse(query.get("state")).data;
  try {
    const onboarding =
      state === undefined
        ? undefined
        : await yoomoneyOnboardingOfState(
            state,
            (await cookies()).get(yoomoneyOnboardingCookie)?.value
          );
    if (onboarding !== undefined) {
      url = new URL(await yoomoneyOnboardingLink(onboarding.id));
      url.searchParams.set("e", "failed");
    }
    const scope = onboarding?.scope ?? (await requireRequestScope());
    if (callback.success) {
      const connected = await finishYoomoneyAuthorization(
        scope,
        callback.data.code,
        callback.data.state
      );
      if (connected.onboardingId !== null) {
        await markYoomoneyOnboardingConnected(connected.onboardingId, {
          cards: connected.cards,
        });
        url.searchParams.delete("e");
      } else {
        url.searchParams.set("yoomoney", "connected");
      }
    } else {
      if (state !== undefined) await cancelYoomoneyAuthorization(scope, state);
      if (query.get("error") === "access_denied") {
        url.searchParams.set(
          onboarding === undefined ? "yoomoney" : "e",
          "declined"
        );
      }
    }
  } catch (error) {
    if (error instanceof UnauthenticatedError) {
      // An onboarding's page says who to open it as.
      if (url.pathname.startsWith("/yoomoney/")) {
        url.searchParams.set("e", "who");
      } else {
        // Back here once signed in, with the same code and state.
        url = new URL("/sign-in", applicationOrigin());
        url.searchParams.set(
          "callbackUrl",
          `/api/yoomoney/callback?${query.toString()}`
        );
      }
    } else {
      console.warn("[yoomoney] callback failed", {
        code: error instanceof YoomoneyError ? error.code : undefined,
        name: error instanceof Error ? error.name : "unknown",
      });
    }
  }
  const response = NextResponse.redirect(url);
  response.headers.set("Cache-Control", "no-store");
  response.headers.set("Referrer-Policy", "no-referrer");
  return response;
}

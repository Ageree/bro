import { NextResponse } from "next/server";
import { startYoomoneyAuthorization } from "@db/services/yoomoney/connection";
import { applicationOrigin } from "@shared/environment/origin";
import { YoomoneyError } from "@shared/yoomoney/api";
import {
  requireRequestScope,
  UnauthenticatedError,
} from "@web/auth/request-scope";

/**
 * The link Bro gives in the chat (`agent/tools/yoomoney.ts`): the person's
 * cabinet session names the workspace, then YooMoney asks for consent.
 */
export async function GET() {
  try {
    const scope = await requireRequestScope();
    const response = NextResponse.redirect(
      await startYoomoneyAuthorization(scope, applicationOrigin())
    );
    response.headers.set("Cache-Control", "no-store");
    response.headers.set("Referrer-Policy", "no-referrer");
    return response;
  } catch (error) {
    if (error instanceof UnauthenticatedError) {
      return NextResponse.redirect(new URL("/sign-in", applicationOrigin()));
    }
    console.warn("[yoomoney] connect failed", {
      code: error instanceof YoomoneyError ? error.code : undefined,
      name: error instanceof Error ? error.name : "unknown",
    });
    return NextResponse.redirect(
      new URL("/workspace?yoomoney=failed", applicationOrigin())
    );
  }
}

import { NextResponse } from "next/server";
import { z } from "zod";
import {
  cancelYoomoneyAuthorization,
  finishYoomoneyAuthorization,
} from "@db/services/yoomoney/connection";
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
 * the Redirect URI (`db/services/yoomoney/connection.ts`).
 */
export async function GET(request: Request) {
  const url = new URL("/workspace", applicationOrigin());
  url.searchParams.set("yoomoney", "failed");
  const query = new URL(request.url).searchParams;
  const callback = callbackSchema.safeParse({
    code: query.get("code"),
    state: query.get("state"),
  });
  try {
    const scope = await requireRequestScope();
    if (callback.success) {
      await finishYoomoneyAuthorization(
        scope,
        callback.data.code,
        callback.data.state
      );
      url.searchParams.set("yoomoney", "connected");
    } else {
      const state = stateSchema.safeParse(query.get("state"));
      if (state.success) await cancelYoomoneyAuthorization(scope, state.data);
      if (query.get("error") === "access_denied")
        url.searchParams.set("yoomoney", "declined");
    }
  } catch (error) {
    if (error instanceof UnauthenticatedError) {
      url.pathname = "/sign-in";
      url.search = "";
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

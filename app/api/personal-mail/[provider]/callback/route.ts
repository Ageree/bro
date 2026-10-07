import { NextResponse } from "next/server";
import { z } from "zod";
import { verifyMailAccount } from "@agent/lib/mail/client";
import {
  cancelMailAuthorization,
  disconnectMail,
  finishMailAuthorization,
} from "@db/services/mail";
import { applicationOrigin } from "@shared/environment/origin";
import { mailProviderSchema } from "@shared/mail/schema";
import {
  requireRequestScope,
  UnauthenticatedError,
} from "@web/auth/request-scope";

const callbackSchema = z.object({
  code: z.string().min(1).max(4096),
  state: z.string().regex(/^[\w-]{43}$/u),
});

export async function GET(
  request: Request,
  { params }: RouteContext<"/api/personal-mail/[provider]/callback">
) {
  const provider = mailProviderSchema.safeParse((await params).provider);
  if (!provider.success)
    return new Response("Неверное подключение почты.", { status: 400 });
  const url = new URL("/workspace", applicationOrigin());
  url.searchParams.set("mail", provider.data);
  url.searchParams.set("mailStatus", "failed");
  const query = new URL(request.url).searchParams;
  const callback = callbackSchema.safeParse({
    code: query.get("code"),
    state: query.get("state"),
  });
  try {
    const scope = await requireRequestScope();
    if (callback.success) {
      await finishMailAuthorization(
        scope,
        provider.data,
        callback.data.code,
        callback.data.state
      );
      try {
        await verifyMailAccount(scope, provider.data);
        url.searchParams.set("mailStatus", "connected");
      } catch {
        await disconnectMail(scope, provider.data);
        url.searchParams.set("mailStatus", "mail_unavailable");
      }
    } else {
      const state = z
        .string()
        .regex(/^[\w-]{43}$/u)
        .safeParse(query.get("state"));
      if (state.success)
        await cancelMailAuthorization(scope, provider.data, state.data);
    }
  } catch (error) {
    if (error instanceof UnauthenticatedError) {
      url.pathname = "/sign-in";
      url.search = "";
    }
  }
  const response = NextResponse.redirect(url);
  response.headers.set("Cache-Control", "no-store");
  response.headers.set("Referrer-Policy", "no-referrer");
  return response;
}

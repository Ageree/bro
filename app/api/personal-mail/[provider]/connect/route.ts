import { NextResponse } from "next/server";
import { startMailAuthorization } from "@db/services/mail";
import { applicationOrigin } from "@shared/environment/origin";
import { mailAccessSchema, mailProviderSchema } from "@shared/mail/schema";
import {
  requireRequestScope,
  UnauthenticatedError,
} from "@web/auth/request-scope";

export async function GET(
  request: Request,
  { params }: RouteContext<"/api/personal-mail/[provider]/connect">
) {
  const provider = mailProviderSchema.safeParse((await params).provider);
  const access = mailAccessSchema.safeParse(
    new URL(request.url).searchParams.get("access") ?? "full"
  );
  if (!provider.success || !access.success)
    return new Response("Неверное подключение почты.", { status: 400 });
  try {
    const scope = await requireRequestScope();
    const url = await startMailAuthorization(
      scope,
      provider.data,
      access.data,
      applicationOrigin()
    );
    const response = NextResponse.redirect(url);
    response.headers.set("Cache-Control", "no-store");
    response.headers.set("Referrer-Policy", "no-referrer");
    return response;
  } catch (error) {
    if (error instanceof UnauthenticatedError) {
      return NextResponse.redirect(new URL("/sign-in", applicationOrigin()));
    }
    return NextResponse.redirect(
      new URL(
        `/workspace?mail=${provider.data}&mailStatus=failed`,
        applicationOrigin()
      )
    );
  }
}

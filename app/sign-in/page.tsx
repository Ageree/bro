import { redirect } from "next/navigation";
import { headers } from "next/headers";
import { LocalPhoneAuthForm } from "@app/sign-in/_components/local-form";
import { PhoneOtpAuthForm } from "@app/sign-in/_components/otp-form";
import { env, localPhoneAuthBypassEnabled } from "@shared/environment";
import { getAuthSession } from "@db/services/auth/session";
import { photonConfigured } from "@shared/photon/credentials";

export default async function SignInPage({
  searchParams,
}: PageProps<"/sign-in">) {
  if (await getAuthSession(await headers())) redirect("/workspace");

  const callbackValue = (await searchParams).callbackUrl;
  const requestedCallback = Array.isArray(callbackValue)
    ? callbackValue[0]
    : callbackValue;
  const callbackUrl =
    requestedCallback?.startsWith("/") && !requestedCallback.startsWith("//")
      ? requestedCallback
      : "/workspace";
  const imessageConfigured = photonConfigured();
  const imessagePhoneNumber =
    localPhoneAuthBypassEnabled || !imessageConfigured
      ? undefined
      : env.IMESSAGE_PHONE_NUMBER;

  return (
    <main className="flex min-h-svh items-center justify-center bg-background px-4 py-8 text-foreground">
      <section className="w-full max-w-sm space-y-6">
        <div className="flex flex-col gap-2">
          <h1 className="type-page-title">Sign In</h1>
          <p className="type-supporting-body text-muted-foreground">
            Enter your phone number to sign in.
          </p>
        </div>
        {!localPhoneAuthBypassEnabled && !imessageConfigured ? (
          <p className="type-supporting-body text-muted-foreground">
            iMessage sign-in is not configured for this deployment. Set its
            Photon project variables.
          </p>
        ) : localPhoneAuthBypassEnabled ? (
          <LocalPhoneAuthForm callbackUrl={callbackUrl} />
        ) : (
          <PhoneOtpAuthForm
            callbackUrl={callbackUrl}
            imessagePhoneNumber={imessagePhoneNumber}
          />
        )}
      </section>
    </main>
  );
}

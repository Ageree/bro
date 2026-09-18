import { betterAuth } from "better-auth";
import { APIError } from "better-auth/api";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { phoneNumber } from "better-auth/plugins/phone-number";
import { account, db, session, user, verification } from "@db";
import { betterAuthBaseURL } from "@shared/environment/origin";
import { localPhoneAuthBypassEnabled } from "@shared/environment";
import { getInstallationSecrets } from "@db/services/installation-secrets";
import { photonConfigured } from "@shared/photon/credentials";
import {
  PhotonDeliveryError,
  photonOtpFailure,
  sendPhotonText,
} from "./photon";
import { phoneUserEmail, phoneUserName } from "./phone-user";
import { isE164PhoneNumber } from "@shared/identity/phone-number";

let authPromise: ReturnType<typeof initializeAuth> | undefined;

export function getAuth() {
  authPromise ??= initializeAuthWithRetry();
  return authPromise;
}

async function initializeAuthWithRetry() {
  try {
    return await initializeAuth();
  } catch (error) {
    authPromise = undefined;
    throw error;
  }
}

async function initializeAuth() {
  const { betterAuthSecret } = await getInstallationSecrets();
  return betterAuth({
    appName: "Local Vault Assistant",
    baseURL: betterAuthBaseURL(),
    database: drizzleAdapter(db, {
      provider: "pg",
      schema: { account, session, user, verification },
    }),
    disabledPaths: [
      "/change-email",
      "/request-password-reset",
      "/reset-password",
      "/reset-password/:token",
      "/send-verification-email",
      "/sign-in/email",
      "/sign-in/social",
      "/sign-up/email",
      "/verify-email",
    ],
    plugins: [
      phoneNumber({
        allowedAttempts: 3,
        expiresIn: 300,
        phoneNumberValidator: isE164PhoneNumber,
        requireVerification: true,
        sendOTP: localPhoneAuthBypassEnabled
          ? () => undefined
          : ({ code, phoneNumber: to }) => sendPhoneCode({ code, to }),
        signUpOnVerification: {
          getTempEmail: phoneUserEmail,
          getTempName: () => phoneUserName,
        },
        verifyOTP: localPhoneAuthBypassEnabled
          ? ({ phoneNumber: value }) => isE164PhoneNumber(value)
          : undefined,
      }),
    ],
    secret: betterAuthSecret,
  });
}

export async function sendPhoneCode({
  code,
  to,
}: {
  readonly code: string;
  readonly to: string;
}) {
  if (!photonConfigured()) {
    throw new APIError("SERVICE_UNAVAILABLE", {
      code: "IMESSAGE_NOT_CONFIGURED",
      message:
        "iMessage sign-in is not configured. Set this deployment's Photon project variables.",
    });
  }

  try {
    await sendPhotonText({
      message: `Local Vault Assistant sign-in code: ${code}. Expires in 5 minutes.`,
      to,
    });
  } catch (error) {
    if (error instanceof PhotonDeliveryError) {
      const failure = photonOtpFailure(error);
      throw new APIError("BAD_GATEWAY", {
        code: failure.code,
        message: failure.message,
        photonError: {
          code: error.code,
          kind: error.kind,
          message: error.photonMessage,
        },
      });
    }

    throw new APIError("BAD_GATEWAY", {
      code: "IMESSAGE_PROJECT_UNAVAILABLE",
      message:
        "This deployment cannot reach its Photon project. Check IMESSAGE_PROJECT_ID and IMESSAGE_PROJECT_SECRET.",
    });
  }
}

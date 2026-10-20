import { betterAuth, type BetterAuthOptions } from "better-auth";
import { APIError, createAuthMiddleware, getIP } from "better-auth/api";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { phoneNumber } from "better-auth/plugins/phone-number";
import * as z from "zod";
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
import { claimSignInCodeSend, releaseSignInCodeSend } from "./code-sends";
import { photonLineFor } from "@db/services/photon-users";
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
    appName: "Bro",
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
      // Nobody here has a password, and for an unverified number this path
      // sends a code past the limit below without asking for one.
      "/sign-in/phone-number",
      "/sign-in/social",
      "/sign-up/email",
      "/verify-email",
    ],
    hooks: {
      before: createAuthMiddleware(async (ctx) => {
        if (localPhoneAuthBypassEnabled || ctx.path !== sendCodePath) return;
        const to = phoneNumberBodySchema.safeParse(ctx.body).data?.phoneNumber;
        // The endpoint itself refuses a malformed number; that sends nothing.
        if (to === undefined || !isE164PhoneNumber(to)) return;
        await limitSignInCodes({ address: requestAddress(ctx), to });
      }),
      after: createAuthMiddleware(async (ctx) => {
        if (ctx.path !== verifyCodePath || ctx.context.newSession === null)
          return;
        const verified = phoneNumberBodySchema.safeParse(ctx.body).data;
        // Registered with Photon right away, so their first iMessage to Bro
        // is delivered; sign-in does not wait for it.
        if (verified !== undefined) void photonLineFor(verified.phoneNumber);
      }),
    },
    plugins: [
      phoneNumber({
        allowedAttempts: 3,
        expiresIn: 300,
        phoneNumberValidator: isE164PhoneNumber,
        requireVerification: true,
        sendOTP: localPhoneAuthBypassEnabled
          ? () => undefined
          : async ({ code, phoneNumber: to }, ctx) => {
              try {
                await sendPhoneCode({ code, to });
              } catch (error) {
                await releaseSignInCodeSend({
                  address: ctx ? requestAddress(ctx) : null,
                  phoneNumber: to,
                }).catch(() => {
                  // Nothing about the number goes to the log.
                  console.warn("[auth] sign-in code slot was not given back");
                });
                throw error;
              }
            },
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

const sendCodePath = "/phone-number/send-otp";
const verifyCodePath = "/phone-number/verify";

/**
 * Caddy sets `x-forwarded-for` to the client alone, and Next keeps it, so
 * this is the visitor's address, not loopback.
 */
function requestAddress(ctx: {
  readonly context: { readonly options: BetterAuthOptions };
  readonly headers?: Headers;
  readonly request?: Request;
}) {
  return getIP(
    ctx.request ?? ctx.headers ?? new Headers(),
    ctx.context.options
  );
}
const phoneNumberBodySchema = z.object({ phoneNumber: z.string() });

/**
 * Better Auth's own limit counts requests per address in each process's
 * memory, so a restart forgets it and a number is never counted at all:
 * anyone could flood a stranger with codes from Bro's iMessage line. This
 * runs before the endpoint stores a new code: a refused request must not
 * replace the code the person already has.
 */
async function limitSignInCodes({
  address,
  to,
}: {
  readonly address: string | null;
  readonly to: string;
}) {
  if (await claimSignInCodeSend({ address, phoneNumber: to })) return;
  throw new APIError("TOO_MANY_REQUESTS", {
    code: "IMESSAGE_CODE_LIMIT_REACHED",
    message:
      "Слишком много запросов кода. Подожди немного и запроси код ещё раз.",
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
      message: `Код входа в Bro: ${code}. Действует 5 минут.`,
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

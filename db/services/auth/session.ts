import * as z from "zod";
import { getAuth } from "@db/services/auth";
import { telegramUserEmailDomain } from "./telegram-user";

/**
 * A signed-in account proved either a phone (the iMessage code) or a
 * Telegram account (`telegramLogin`); a Telegram account has no phone until
 * the person adds one.
 */
const authenticatedSessionSchema = z
  .object({
    user: z.union([
      z
        .object({
          id: z.string().min(1),
          phoneNumber: z.string().min(1),
          phoneNumberVerified: z.literal(true),
        })
        .loose(),
      z
        .object({
          email: z.string().endsWith(`@${telegramUserEmailDomain}`),
          emailVerified: z.literal(true),
          id: z.string().min(1),
        })
        .loose()
        .transform(({ id }) => ({ id, phoneNumber: undefined })),
    ]),
  })
  .loose();

export async function getAuthSession(headers: Headers) {
  const auth = await getAuth();
  const session = await auth.api.getSession({ headers });
  const parsed = authenticatedSessionSchema.safeParse(session);
  return parsed.success ? parsed.data : null;
}

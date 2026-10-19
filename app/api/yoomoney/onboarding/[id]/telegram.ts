import { createHmac, timingSafeEqual } from "node:crypto";
import * as z from "zod";
import { env } from "@shared/environment";

/** Older launch data proves nothing: the button is pressed now. */
const maxAgeMs = 24 * 60 * 60_000;

const userSchema = z.object({ id: z.number().int().positive() });

/**
 * The Telegram user a Mini App was opened by, when Telegram signed its
 * launch data (`Telegram.WebApp.initData`) with Bro's bot token
 * (core.telegram.org/bots/webapps, «Validating data»): the string of every
 * other field as `key=value`, sorted by key and joined by newlines, under
 * HMAC-SHA256 keyed by HMAC-SHA256 of the token keyed by «WebAppData».
 * Only Bro's own button opens the page with it.
 */
export function telegramWebAppUser(initData: string, now = Date.now()) {
  const token = env.TELEGRAM_BOT_TOKEN;
  if (!token || initData.length === 0 || initData.length > 8192) {
    return undefined;
  }
  const fields = new URLSearchParams(initData);
  const given = fields.get("hash");
  if (given === null) return undefined;
  fields.delete("hash");
  const checked = [...fields.entries()]
    .toSorted(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([key, value]) => `${key}=${value}`)
    .join("\n");
  const secret = createHmac("sha256", "WebAppData").update(token).digest();
  const expected = createHmac("sha256", secret).update(checked).digest("hex");
  const a = Buffer.from(given);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return undefined;
  const signedAt = Number(fields.get("auth_date")) * 1000;
  if (!Number.isFinite(signedAt) || now - signedAt > maxAgeMs) return undefined;
  const user = fields.get("user");
  if (user === null) return undefined;
  try {
    const parsed: unknown = JSON.parse(user);
    const id = userSchema.safeParse(parsed).data?.id;
    return id === undefined ? undefined : String(id);
  } catch {
    return undefined;
  }
}

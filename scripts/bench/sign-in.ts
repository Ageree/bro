import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { z } from "zod";
import { writeCookieJar } from "./cookies.ts";

/**
 * Signs the benchmark in the way a person signs in on the site: a code to
 * the phone, then the code back. The two halves are separate commands
 * because the code comes from the owner, possibly minutes later, and is
 * passed straight to `verify` — it is never logged or stored.
 */

async function post(
  host: URL,
  path: string,
  body: Readonly<Record<string, string>>
) {
  const response = await fetch(new URL(path, host), {
    body: JSON.stringify(body),
    // better-auth refuses a cross-site POST; the site's own origin passes.
    headers: { "content-type": "application/json", origin: host.origin },
    method: "POST",
    redirect: "manual",
  });
  if (!response.ok) {
    throw new Error(
      `${path} answered ${String(response.status)}: ${(await response.text()).slice(0, 300)}`
    );
  }
  return response;
}

export async function sendSignInCode(host: URL, phoneNumber: string) {
  await post(host, "/api/auth/phone-number/send-otp", { phoneNumber });
}

export async function verifySignInCode(
  host: URL,
  phoneNumber: string,
  code: string,
  cookieFile: string
) {
  const response = await post(host, "/api/auth/phone-number/verify", {
    code,
    phoneNumber,
  });
  await mkdir(dirname(cookieFile), { mode: 0o700, recursive: true });
  await writeCookieJar(cookieFile, host, response.headers.getSetCookie());
}

const sessionSchema = z
  .object({ session: z.object({ expiresAt: z.coerce.date() }) })
  .nullable();

/**
 * When the cookie's session expires. Throws when the site no longer knows
 * the session, so a run fails before its first message instead of on it.
 */
export async function sessionExpiry(host: URL, cookie: string) {
  const response = await fetch(new URL("/api/auth/get-session", host), {
    headers: { cookie, origin: host.origin },
    redirect: "manual",
  });
  const session = response.ok
    ? sessionSchema.safeParse(await response.json())
    : undefined;
  if (!session?.success || session.data === null) {
    throw new Error(
      `${host.origin} does not know this session any more: sign in again with \`pnpm bench otp\` and \`pnpm bench verify\`.`
    );
  }
  return session.data.session.expiresAt;
}

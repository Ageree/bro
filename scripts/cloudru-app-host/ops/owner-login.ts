import { inArray, or, sql } from "drizzle-orm";
import { db, user } from "@db";
import { mintTelegramLoginLink } from "@db/services/auth/telegram-login";
import { env } from "@shared/environment";
import { applicationOrigin } from "@shared/environment/origin";

/**
 * A sign-in link into the owner's own account, for an operator's session
 * that tests Bro there (owner, 21.10: with iMessage off no code reaches
 * the phone):
 *
 *   host.py ops NAME owner-login.sh s3put:<result key>
 *
 * The link is the bot's one (`mintTelegramLoginLink`: ten minutes, once)
 * and only for the account on `ADMIN_USER_IDS`; it goes to the PUT URL,
 * never to the job's log. The operator can write the database anyway, so
 * this gives nothing new — it only keeps that power narrow.
 * `owner-login.py` runs it and saves the session for `pnpm bench`.
 */

async function main() {
  const [resultUrl] = process.argv.slice(2);
  if (!resultUrl?.startsWith("https://")) {
    throw new Error("Usage: owner-login.sh s3put:<result key>");
  }
  const admins = (env.ADMIN_USER_IDS ?? []).map((entry) => entry.toLowerCase());
  if (admins.length === 0) throw new Error("ADMIN_USER_IDS is empty.");
  const accounts = await db
    .select({ id: user.id })
    .from(user)
    .where(
      or(
        inArray(sql`lower(${user.id})`, admins),
        inArray(sql`lower(${user.email})`, admins)
      )
    );
  const [account, ...others] = accounts;
  if (!account || others.length > 0) {
    throw new Error(
      `ADMIN_USER_IDS names ${String(accounts.length)} accounts, not one.`
    );
  }
  const token = await mintTelegramLoginLink(account.id);
  const link = new URL("/api/auth/telegram-login/open", applicationOrigin());
  link.searchParams.set("t", token);
  const answer = await fetch(resultUrl, {
    body: JSON.stringify({ link: link.toString() }),
    method: "PUT",
  });
  if (!answer.ok) throw new Error(`result upload ${String(answer.status)}`);
  console.log(JSON.stringify({ status: "ready", validMinutes: 10 }));
}

try {
  await main();
} catch (error) {
  // Database errors carry SQL params; the message of our own is enough.
  console.error(
    error instanceof Error && !("cause" in error && error.cause)
      ? error.message
      : "owner-login failed"
  );
  process.exitCode = 1;
}

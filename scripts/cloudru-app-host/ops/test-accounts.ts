import { randomUUID } from "node:crypto";
import { eq, inArray } from "drizzle-orm";
import {
  db,
  phoneNumberRequests,
  phoneNumbers,
  user,
  userProfiles,
  workspaceMemberships,
  workspaces,
} from "@db";
import { mintTelegramLoginLink } from "@db/services/auth/telegram-login";
import { telegramUserEmailDomain } from "@db/services/auth/telegram-user";
import { applicationOrigin } from "@shared/environment/origin";
import { accessScopeForUser } from "@shared/identity/access-scope";

/**
 * Test accounts on production for live checks no real person stands
 * behind (Bro ↔ Bro, 25.10): people who talk to Bro on the website only.
 *
 *   host.py ops NAME test-accounts.sh ensure s3put:<result key>
 *
 * Makes each account once and puts a one-time sign-in link for every one
 * (`mintTelegramLoginLink`: ten minutes, once) to the PUT URL, never to the
 * job's log; `test-accounts.py` runs it and saves one cookie file each.
 *
 * The mail ends in Telegram's domain because the session check lets an
 * account without a phone in by it alone (`getAuthSession`); no Telegram
 * identity is bound, so the account has no messenger. The workspace and
 * its membership are written here, before anything calls `ensureScope`:
 * that one queues a dedicated phone number for a workspace it creates
 * (`PHONE_AUTO_PROVISION`), and the minute's tick buys it. A request left
 * by anything else is deleted in the same transaction. The workspace counts
 * as introduced, so the first message is not Bro's introduction.
 */
const testAccounts = [
  {
    firstName: "Аня",
    key: "anya",
    name: "Тест Аня",
    timeZone: "Asia/Yekaterinburg",
  },
  {
    firstName: "Борис",
    key: "boris",
    name: "Тест Борис",
    timeZone: "Europe/Moscow",
  },
  {
    firstName: "Вика",
    key: "vika",
    name: "Тест Вика",
    timeZone: "Europe/Moscow",
  },
  {
    firstName: "Гоша",
    key: "gosha",
    name: "Тест Гоша",
    timeZone: "Europe/Moscow",
  },
] as const;

async function ensureAccount(account: (typeof testAccounts)[number]) {
  const email = `bro-test-${account.key}@${telegramUserEmailDomain}`;
  const now = new Date();
  return db.transaction(async (transaction) => {
    const [created] = await transaction
      .insert(user)
      .values({
        email,
        emailVerified: true,
        id: randomUUID(),
        name: account.name,
      })
      .onConflictDoNothing({ target: user.email })
      .returning({ id: user.id });
    const [found] = created
      ? [created]
      : await transaction
          .select({ id: user.id })
          .from(user)
          .where(eq(user.email, email))
          .limit(1);
    if (!found) throw new Error(`No account for ${account.key}.`);
    const scope = accessScopeForUser(`better-auth:${found.id}`);
    await transaction
      .insert(workspaces)
      .values({ createdAt: now, id: scope.workspaceId, introducedAt: now })
      .onConflictDoNothing({ target: workspaces.id });
    await transaction
      .insert(workspaceMemberships)
      .values({
        createdAt: now,
        role: "owner",
        userId: scope.userId,
        workspaceId: scope.workspaceId,
      })
      .onConflictDoNothing({
        target: [workspaceMemberships.workspaceId, workspaceMemberships.userId],
      });
    await transaction
      .insert(userProfiles)
      .values({
        firstName: account.firstName,
        timezone: account.timeZone,
        workspaceId: scope.workspaceId,
      })
      .onConflictDoUpdate({
        set: {
          firstName: account.firstName,
          timezone: account.timeZone,
          updatedAt: now,
        },
        target: userProfiles.workspaceId,
      });
    await transaction
      .delete(phoneNumberRequests)
      .where(eq(phoneNumberRequests.workspaceId, scope.workspaceId));
    return {
      created: created !== undefined,
      key: account.key,
      name: account.name,
      userId: found.id,
      workspaceId: scope.workspaceId,
    };
  });
}

async function main() {
  const [command, resultUrl] = process.argv.slice(2);
  if (command !== "ensure" || !resultUrl?.startsWith("https://")) {
    throw new Error("Usage: test-accounts.sh ensure s3put:<result key>");
  }
  const accounts = [];
  for (const account of testAccounts)
    // oxlint-disable-next-line eslint/no-await-in-loop -- One account after another, each in its own transaction.
    accounts.push(await ensureAccount(account));
  const ids = accounts.map((account) => account.workspaceId);
  const [requests, numbers] = await Promise.all([
    db
      .select({ workspaceId: phoneNumberRequests.workspaceId })
      .from(phoneNumberRequests)
      .where(inArray(phoneNumberRequests.workspaceId, ids)),
    db
      .select({ workspaceId: phoneNumbers.workspaceId })
      .from(phoneNumbers)
      .where(inArray(phoneNumbers.workspaceId, ids)),
  ]);
  const links = [];
  for (const account of accounts) {
    const link = new URL("/api/auth/telegram-login/open", applicationOrigin());
    // oxlint-disable-next-line eslint/no-await-in-loop -- One link per account.
    link.searchParams.set("t", await mintTelegramLoginLink(account.userId));
    links.push({ key: account.key, link: link.toString() });
  }
  const answer = await fetch(resultUrl, {
    body: JSON.stringify({ accounts: links }),
    method: "PUT",
  });
  if (!answer.ok) throw new Error(`result upload ${String(answer.status)}`);
  console.log(
    JSON.stringify({
      accounts: accounts.map(({ created, key, name, workspaceId }) => ({
        created,
        key,
        name,
        workspaceId,
      })),
      phoneNumberRequests: requests.length,
      phoneNumbers: numbers.length,
      validMinutes: 10,
    })
  );
}

try {
  await main();
} catch (error) {
  // Database errors carry SQL params; the message of our own is enough.
  console.error(
    error instanceof Error && !("cause" in error && error.cause)
      ? error.message
      : "test-accounts failed"
  );
  process.exitCode = 1;
}

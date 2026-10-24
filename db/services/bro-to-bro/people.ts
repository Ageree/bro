import { and, eq, inArray, sql } from "drizzle-orm";
import {
  channelIdentities,
  type db,
  user,
  userProfiles,
  workspaceMemberships,
} from "@db";
import { phoneUserName } from "@db/services/auth/phone-user";
import { telegramUserName } from "@db/services/auth/telegram-user";

const placeholderNames = new Set([phoneUserName, telegramUserName]);

/**
 * A word of a name: letters of any alphabet with their marks, a hyphen or an
 * apostrophe only between them — «Пётр», «Анна-Мария», «O'Brien».
 */
const nameWordPattern = /(?:\p{L}\p{M}*)+(?:[-'’](?:\p{L}\p{M}*)+)*/gu;
const nameWords = 3;
const nameLength = 40;

/**
 * A person's own name as the other side may read it, or null when nothing of
 * it is left. They set it themselves (`/personal-info`, Telegram), and it
 * reaches the other side's reports, its envoy and its calendar, so only its
 * words go — no dots, colons, digits, emoji or line breaks — three of them
 * and 40 characters at most: «Петя 🍕» is «Петя», «Dr. Smith» is «Dr Smith».
 */
function personName(text: string | null) {
  const words = (text ?? "").normalize("NFC").match(nameWordPattern) ?? [];
  let name = words.slice(0, nameWords).join(" ");
  while (name.length > nameLength && name.includes(" "))
    name = name.slice(0, name.lastIndexOf(" "));
  return name === "" ? null : name.slice(0, nameLength);
}

/** A Telegram username as Telegram allows one, or null. */
function telegramName(text: string | null) {
  return text !== null && /^[A-Za-z\d_]{4,32}$/u.test(text) ? text : null;
}

/**
 * How the people of a link are named to each other, the one place their
 * names are read: the first name of their profile, else the account's own
 * name (Telegram's, for an account the bot made) unless it is a
 * placeholder — and none at all when that does not read as a name
 * (`personName`); the Telegram username and when the account was made, by
 * which an inviter recognizes who accepted.
 */
export async function readBroPeople(
  executor: Pick<typeof db, "select">,
  workspaceIds: readonly string[]
) {
  const rows =
    workspaceIds.length === 0
      ? []
      : await executor
          .select({
            workspaceId: workspaceMemberships.workspaceId,
            firstName: userProfiles.firstName,
            accountName: user.name,
            accountCreatedAt: user.createdAt,
            telegramUsername: channelIdentities.username,
          })
          .from(workspaceMemberships)
          .leftJoin(
            userProfiles,
            eq(userProfiles.workspaceId, workspaceMemberships.workspaceId)
          )
          .leftJoin(
            user,
            eq(workspaceMemberships.userId, sql`'better-auth:' || ${user.id}`)
          )
          .leftJoin(
            channelIdentities,
            and(
              eq(
                channelIdentities.workspaceId,
                workspaceMemberships.workspaceId
              ),
              eq(channelIdentities.channel, "telegram")
            )
          )
          .where(inArray(workspaceMemberships.workspaceId, [...workspaceIds]));
  return new Map(
    rows.map((row) => {
      const firstName = row.firstName?.trim() ?? "";
      const accountName = row.accountName?.trim() ?? "";
      const name = personName(
        firstName !== ""
          ? firstName
          : placeholderNames.has(accountName)
            ? null
            : accountName
      );
      return [
        row.workspaceId,
        {
          name,
          telegramUsername: telegramName(row.telegramUsername),
          accountCreatedAt: row.accountCreatedAt,
        },
      ] as const;
    })
  );
}

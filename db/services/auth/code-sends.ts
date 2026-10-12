import { createHash } from "node:crypto";
import { and, count, eq, gt, inArray, lt, sql } from "drizzle-orm";
import { db, signInCodeSends } from "@db";

const minuteMs = 60_000;
const dayMs = 24 * 60 * minuteMs;

/**
 * How many codes one number and one client address get. A person who mistyped
 * or lost a code asks again a couple of times; a flood is anything past that.
 * An address is shared by a household or a mobile carrier's NAT, so it gets
 * more than a number.
 */
export const signInCodeLimits = {
  address: [
    { max: 10, windowMs: 10 * minuteMs },
    { max: 40, windowMs: dayMs },
  ],
  phone: [
    { max: 3, windowMs: 10 * minuteMs },
    { max: 10, windowMs: dayMs },
  ],
} as const;

function hashed(kind: "address" | "phone", value: string) {
  return `${kind}:${createHash("sha256").update(value).digest("hex")}`;
}

/** The counters one code goes against: its number and, when known, its sender. */
function keysOf({
  address,
  phoneNumber,
}: {
  readonly address: string | null;
  readonly phoneNumber: string;
}) {
  return [
    { key: hashed("phone", phoneNumber), limits: signInCodeLimits.phone },
    ...(address === null
      ? []
      : [
          { key: hashed("address", address), limits: signInCodeLimits.address },
        ]),
  ];
}

/**
 * Counts one sign-in code against the number and the client address, unless
 * either has used up a window. Answers whether the code may go out; a refused
 * one is not counted, so waiting is enough to get the next. The keys are
 * locked in a fixed order, so two requests for the same number cannot both
 * take its last code.
 */
export async function claimSignInCodeSend({
  address,
  now = new Date(),
  phoneNumber,
}: {
  readonly address: string | null;
  readonly now?: Date;
  readonly phoneNumber: string;
}) {
  const keys = keysOf({ address, phoneNumber });
  return db.transaction(async (transaction) => {
    for (const { key } of keys.toSorted((a, b) => a.key.localeCompare(b.key))) {
      // oxlint-disable-next-line eslint/no-await-in-loop -- Locks are taken one by one, in order.
      await transaction.execute(
        sql`select pg_advisory_xact_lock(hashtextextended(${`sign-in-code:${key}`}, 0))`
      );
    }
    await transaction
      .delete(signInCodeSends)
      .where(lt(signInCodeSends.sentAt, new Date(now.getTime() - dayMs)));
    for (const { key, limits } of keys) {
      for (const { max, windowMs } of limits) {
        // oxlint-disable-next-line eslint/no-await-in-loop -- Each window is checked before any send is counted.
        const [row] = await transaction
          .select({ sent: count() })
          .from(signInCodeSends)
          .where(
            and(
              eq(signInCodeSends.key, key),
              gt(signInCodeSends.sentAt, new Date(now.getTime() - windowMs))
            )
          );
        if ((row?.sent ?? 0) >= max) return false;
      }
    }
    await transaction
      .insert(signInCodeSends)
      .values(keys.map(({ key }) => ({ key, sentAt: now })));
    return true;
  });
}

/**
 * Gives back the slot of a code that never left: when iMessage fails, three
 * failures in a row would otherwise lock the person out for ten minutes. The
 * latest send under each key goes, which is this one unless another request
 * for the same number raced it; then that one is freed instead, and either
 * way the count matches the codes that went out.
 */
export async function releaseSignInCodeSend({
  address,
  phoneNumber,
}: {
  readonly address: string | null;
  readonly phoneNumber: string;
}) {
  const keys = keysOf({ address, phoneNumber }).map(({ key }) => key);
  await db.execute(sql`
    delete from ${signInCodeSends}
    where ctid in (
      select distinct on (${signInCodeSends.key}) ctid
      from ${signInCodeSends}
      where ${inArray(signInCodeSends.key, keys)}
      order by ${signInCodeSends.key}, ${signInCodeSends.sentAt} desc
    )
  `);
}

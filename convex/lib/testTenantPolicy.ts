/**
 * Test tenants: who they are, and why the range is a constant.
 *
 * A tenant whose phone sits in the North American fictional range (area code
 * 555, exchange 555 — the block no carrier ever assigns) is a test tenant.
 * Everything else follows from that one predicate:
 *
 *   - `deliverHuman` records its outbound into `testTranscript` instead of
 *     sending it, so every path that can speak to a human — the agent turn, a
 *     wakeup, browser follow-through, `profile_setup` — is drivable with no
 *     phone in the room.
 *   - the transcript and reset routes refuse any phone outside the range, so a
 *     suite accidentally pointed at production still cannot read or clear a
 *     real person's conversation.
 *   - inbound counting and browser-job quota skip it, so a nightly run does
 *     not spend a real tenant's month.
 *
 * The prefix is a constant, not an env var. An env-configurable one is a
 * single typo (`+7`) away from silencing every real person on the deployment,
 * and that failure is silent by construction: Bro would simply stop speaking
 * and the transcript table would fill up instead. A constant cannot be
 * misconfigured at deploy time, and changing it is a diff that `npm run check`
 * sees.
 */
export const TEST_PHONE_PREFIX = "+1555555";

/** Digits of room inside the range — `+1555555XXXX`, one tenant per scenario. */
const SCENARIO_DIGITS = 4;

export function isTestPhone(phone: string | null | undefined): boolean {
  if (typeof phone !== "string") return false;
  const trimmed = phone.trim();
  // A bare prefix is not a tenant: require at least one digit past it, so a
  // truncated or half-built number never reads as a test phone.
  return trimmed.startsWith(TEST_PHONE_PREFIX) && trimmed.length > TEST_PHONE_PREFIX.length;
}

/**
 * One stable phone per scenario name, so scenarios cannot contaminate each
 * other: wakeups, browser state and the transcript are all keyed by phone,
 * and two scenarios sharing a tenant would read each other's reminders and
 * bubbles. FNV-1a because this has to give the same answer in the Convex
 * runtime, in the agent, and in the runner — no `node:crypto`.
 */
export function testPhoneFor(scenario: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < scenario.length; i++) {
    hash ^= scenario.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  const slot = String(hash % 10 ** SCENARIO_DIGITS).padStart(SCENARIO_DIGITS, "0");
  return `${TEST_PHONE_PREFIX}${slot}`;
}

/**
 * The synthetic Photon inbound a test drives Bro with. It is built here rather
 * than in the runner so the shape stays next to `parsePhotonInboundJson`, the
 * code that has to read it back: a test that builds its own payload inline is
 * a test that silently stops exercising the real parser the day the shape
 * changes.
 *
 * `service: "iMessage"` keeps it on the blue path — Bro refuses SMS/RCS, and a
 * payload without it would be testing the refusal instead of the agent.
 */
export function photonTestInbound(opts: {
  phone: string;
  text: string;
  spaceId?: string;
  messageId?: string;
  assignedPhoneNumber?: string;
}): Record<string, unknown> {
  const spaceId = opts.spaceId ?? testSpaceId(opts.phone);
  return {
    event: "message.received",
    space: {
      id: spaceId,
      assignedPhoneNumber: opts.assignedPhoneNumber ?? `${TEST_PHONE_PREFIX}0000`,
    },
    user: { id: `test-user-${opts.phone}` },
    message: {
      id: opts.messageId ?? `test-msg-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      direction: "inbound",
      service: "iMessage",
      sender: { id: opts.phone, service: "iMessage", phoneNumber: opts.phone },
      content: { type: "text", text: opts.text },
    },
  };
}

/** The conversation a test tenant talks in. Stable per phone, like a real thread. */
export function testSpaceId(phone: string): string {
  return `${TEST_SPACE_PREFIX}${phone}`;
}

const TEST_SPACE_PREFIX = "test-space-";

/**
 * The test tenant behind a conversation id, or undefined for a real thread.
 *
 * The transport needs this because not everything Bro says to a person goes
 * through `deliverHuman`: the welcome letter, the Telegram invite and the
 * quota paywall are written straight to Photon with a conversation id and no
 * tenant in hand. Recording only at the `deliverHuman` layer left those
 * invisible — the send failed against a number no carrier assigns, the error
 * was swallowed by the caller's try/catch, and the scenario saw silence.
 */
export function testPhoneFromSpaceId(
  conversationId: string | null | undefined,
): string | undefined {
  if (typeof conversationId !== "string") return undefined;
  const id = conversationId.trim();
  if (!id.startsWith(TEST_SPACE_PREFIX)) return undefined;
  const phone = id.slice(TEST_SPACE_PREFIX.length);
  return isTestPhone(phone) ? phone : undefined;
}

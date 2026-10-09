import type { loginHandoffs } from "@db/schema/login-handoffs";

type Row = typeof loginHandoffs.$inferSelect;

/** A stored sign-in window: claimed from a phone, ten minutes of viewing left. */
export function handoffRow(
  overrides: Partial<Row> = {},
  now = new Date("2026-10-09T12:00:00Z")
): Row {
  return {
    allowedDomains: ["ozon.ru"],
    claimedAt: new Date(now.getTime() - 5 * 60_000),
    conversationChannel: "telegram",
    conversationId: "telegram:1",
    createdAt: new Date(now.getTime() - 6 * 60_000),
    createdByUserId: "alice",
    deviceHash: "phone",
    domain: "ozon.ru",
    expiresAt: new Date(now.getTime() + 20 * 60_000),
    finishedAt: null,
    id: "link-1",
    replyAnchorMessageId: null,
    report: null,
    reportAttempts: 0,
    reportClaimedAt: null,
    reportDeliveredAt: null,
    resultHost: null,
    rootSessionId: null,
    signedIn: null,
    siteUrl: "https://www.ozon.ru/",
    state: "claimed",
    viewUntil: new Date(now.getTime() + 10 * 60_000),
    workerId: "h_worker",
    workerOpenedAt: new Date(now.getTime() - 5 * 60_000),
    workspaceId: "workspace:alice",
    ...overrides,
  };
}

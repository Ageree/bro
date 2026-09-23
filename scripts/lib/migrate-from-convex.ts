import { createHash } from "node:crypto";
import { parseArgs } from "node:util";
import { and, eq, sql } from "drizzle-orm";
import { billingAccounts, channelIdentities, db, user, vaultItems } from "@db";
import { recordPayment } from "@db/services/billing";
import { ensureVerifiedPhoneUser } from "@db/services/auth/phone-user";
import {
  findOnboardingRequest,
  recordOnboardingRequest,
} from "@db/services/onboarding-requests";
import { recordOrder } from "@db/services/orders";
import { createPhotonSharedUser } from "@db/services/photon-users";
import { claimWorkspaceIntroduction, ensureScope } from "@db/services/scope";
import { patchUserProfile, readUserProfile } from "@db/services/user-profile";
import { saveVaultItem } from "@db/services/vault";
import {
  accessScopeForUser,
  type AccessScope,
} from "@shared/identity/access-scope";
import { isE164PhoneNumber } from "@shared/identity/phone-number";
import {
  isSupportedTimeZone,
  type UserProfilePatch,
} from "@shared/user-profile/schema";
import { convexMigrationEnv } from "../env/convex-migration.ts";
import {
  readConvexExport,
  type ConvexExport,
  type ConvexOrder,
  type ConvexPayment,
  type ConvexTenant,
  type ConvexVaultItem,
} from "./convex-export.ts";
import {
  decryptLegacyVaultSecret,
  legacyVaultCreateItem,
  legacyVaultMasterKey,
} from "./legacy-vault.ts";

/**
 * Imports the people of the previous product, and what belonged to them, out
 * of an unzipped Convex snapshot and into this installation.
 *
 * The import is re-runnable by construction rather than by transaction. Every
 * write goes through the application's own services, which address their rows
 * by a natural key — the phone number, the YooKassa payment id, the merchant's
 * order number, the workspace — and the vault skips an item whose label and
 * kind a workspace already holds. That matters twice over: a run interrupted
 * halfway is finished by running it again, and `--via-neon-http` has no
 * interactive transactions at all, so per-tenant atomicity was never available
 * to lean on.
 */
export interface ConvexMigrationOptions {
  readonly dryRun: boolean;
  readonly exportDirectory: string;
  readonly onlyPhoneNumbers: readonly string[];
  readonly registerPhoton: boolean;
  readonly skipVault: boolean;
}

interface VaultOutcome {
  readonly created: number;
  readonly existing: number;
  readonly failed: number;
}

type TenantStatus = "failed" | "migrated" | "skipped";
type TelegramOutcome = "conflict" | "linked" | "none";
/** `new` is the dry-run answer: no account exists for this phone number yet. */
type AccountOutcome = "created" | "new" | "reused";

interface TenantOutcome {
  readonly account: AccountOutcome;
  readonly maskedPhoneNumber: string;
  readonly notes: readonly string[];
  readonly orders: number;
  readonly paidUntil: string | null;
  readonly payments: number;
  readonly photonNumber: string | null;
  readonly profileFields: readonly string[];
  readonly status: TenantStatus;
  readonly telegram: TelegramOutcome;
  readonly vault: VaultOutcome;
}

export interface MigrationSummary {
  readonly dryRun: boolean;
  readonly failed: number;
  readonly migrated: number;
  readonly skipped: number;
  readonly tenants: readonly TenantOutcome[];
}

interface PhoneAccount {
  readonly created: boolean;
  readonly userId: string;
}

interface TenantWork {
  readonly masterKey: Buffer | undefined;
  readonly options: ConvexMigrationOptions;
  readonly orders: readonly ConvexOrder[];
  readonly payments: readonly ConvexPayment[];
  readonly snapshot: ConvexExport;
  readonly tenant: ConvexTenant;
}

const emptyVaultOutcome: VaultOutcome = { created: 0, existing: 0, failed: 0 };

/**
 * The caller digest stored beside an onboarding assignment. Public onboarding
 * records the visitor's address to rate-limit it; a migrated line was not
 * requested by a visitor at all, so it is attributed to the import itself.
 */
const migrationCallerHash = createHash("sha256")
  .update("convex-migration")
  .digest("hex");

export function parseMigrationArguments(
  argv: readonly string[]
): ConvexMigrationOptions {
  const { values } = parseArgs({
    args: [...argv],
    options: {
      "dry-run": { type: "boolean" },
      export: { type: "string" },
      only: { multiple: true, type: "string" },
      "register-photon": { type: "boolean" },
      "skip-vault": { type: "boolean" },
      "via-neon-http": { type: "boolean" },
    },
    strict: true,
  });

  const exportDirectory = values.export?.trim();
  if (!exportDirectory) {
    throw new Error(
      "Pass --export <dir> with the unzipped Convex export directory."
    );
  }

  return {
    dryRun: values["dry-run"] === true,
    exportDirectory,
    onlyPhoneNumbers: (values.only ?? []).flatMap((value) =>
      value
        .split(",")
        .map((phoneNumber) => phoneNumber.trim())
        .filter((phoneNumber) => phoneNumber.length > 0)
    ),
    registerPhoton: values["register-photon"] === true,
    skipVault: values["skip-vault"] === true,
  };
}

export async function migrateFromConvex(
  options: ConvexMigrationOptions
): Promise<MigrationSummary> {
  const snapshot = await readConvexExport(options.exportDirectory);
  const masterKey = options.skipVault
    ? undefined
    : legacyVaultMasterKey(convexMigrationEnv.BRO_VAULT_KEY);
  const selected = selectTenants(snapshot.tenants, options.onlyPhoneNumbers);

  console.log(
    `${options.dryRun ? "Dry run" : "Migrating"}: ${String(selected.length)} of ${String(snapshot.tenants.length)} tenants, vault ${options.skipVault ? "skipped" : "included"}.`
  );

  const outcomes: TenantOutcome[] = [];
  /* oxlint-disable eslint/no-await-in-loop -- Tenants are imported one at a time so a failure is attributable and the database sees one person's writes at a time. */
  for (const tenant of selected) {
    const outcome = await runTenant({
      masterKey,
      options,
      orders: snapshot.orders.filter((row) => row.tenantId === tenant.id),
      payments: snapshot.payments.filter((row) => row.tenantId === tenant.id),
      snapshot,
      tenant,
    });
    console.log(formatTenantOutcome(outcome));
    outcomes.push(outcome);
  }
  /* oxlint-enable eslint/no-await-in-loop */

  const summary: MigrationSummary = {
    dryRun: options.dryRun,
    failed: outcomes.filter((outcome) => outcome.status === "failed").length,
    migrated: outcomes.filter((outcome) => outcome.status === "migrated")
      .length,
    skipped: outcomes.filter((outcome) => outcome.status === "skipped").length,
    tenants: outcomes,
  };
  console.log(
    `Done: ${String(summary.migrated)} migrated, ${String(summary.skipped)} skipped, ${String(summary.failed)} failed.`
  );
  return summary;
}

function selectTenants(
  tenants: readonly ConvexTenant[],
  onlyPhoneNumbers: readonly string[]
) {
  if (onlyPhoneNumbers.length === 0) return tenants;
  const wanted = new Set(onlyPhoneNumbers);
  return tenants.filter(
    (tenant) => tenant.phoneE164 !== undefined && wanted.has(tenant.phoneE164)
  );
}

async function runTenant(work: TenantWork): Promise<TenantOutcome> {
  const phoneNumber = work.tenant.phoneE164?.trim() ?? "";
  const maskedPhoneNumber = maskPhoneNumber(phoneNumber, work.tenant.id);

  if (work.tenant.status !== "active") {
    return skippedTenant(maskedPhoneNumber, "the tenant is not active");
  }
  if (!isE164PhoneNumber(phoneNumber)) {
    return skippedTenant(
      maskedPhoneNumber,
      "the tenant has no valid E.164 phone number"
    );
  }

  try {
    const outcome = await migrateTenant(work, phoneNumber, maskedPhoneNumber);
    return { ...outcome, notes: outcome.notes.map(redactPhoneNumbers) };
  } catch (error) {
    return {
      account: "new",
      maskedPhoneNumber,
      notes: [failureNote(error instanceof Error ? error : undefined)],
      orders: 0,
      paidUntil: null,
      payments: 0,
      photonNumber: null,
      profileFields: [],
      status: "failed",
      telegram: "none",
      vault: emptyVaultOutcome,
    };
  }
}

async function migrateTenant(
  work: TenantWork,
  phoneNumber: string,
  maskedPhoneNumber: string
): Promise<TenantOutcome> {
  const { dryRun } = work.options;
  const account = dryRun
    ? await findPhoneUser(phoneNumber)
    : await ensurePhoneUser(phoneNumber);
  const scope = account
    ? accessScopeForUser(`better-auth:${account.userId}`)
    : undefined;
  if (scope && !dryRun) {
    await ensureScope(scope);
    // A person carried over from Convex has met Bro already; their first
    // message after the move must not be treated as a first contact.
    await claimWorkspaceIntroduction(scope);
  }

  const notes: string[] = [];

  const profileFields = await migrateProfile(work, scope);
  const paidUntil = await migratePaidUntil(work, scope);
  const payments = await migratePayments(work, scope);
  const orders = await migrateOrders(work, scope);
  const telegram = await migrateTelegramIdentity(work, account, scope, notes);
  const photonNumber = await migratePhotonLine(work, phoneNumber, notes);
  const vault = await migrateVault(work, scope, notes);

  return {
    account: accountOutcome(account),
    maskedPhoneNumber,
    notes,
    orders,
    paidUntil,
    payments,
    photonNumber,
    profileFields,
    status: vault.failed > 0 ? "failed" : "migrated",
    telegram,
    vault,
  };
}

async function ensurePhoneUser(phoneNumber: string): Promise<PhoneAccount> {
  const ensured = await ensureVerifiedPhoneUser(phoneNumber);
  if (!ensured) {
    throw new Error(
      "an account already holds this phone number without a verified phone sign-in"
    );
  }
  return ensured;
}

async function findPhoneUser(
  phoneNumber: string
): Promise<PhoneAccount | undefined> {
  const [existing] = await db
    .select({ id: user.id, verified: user.phoneNumberVerified })
    .from(user)
    .where(eq(user.phoneNumber, phoneNumber))
    .limit(1);
  if (!existing) return undefined;
  if (existing.verified !== true) {
    throw new Error(
      "an account already holds this phone number without a verified phone sign-in"
    );
  }
  return { created: false, userId: existing.id };
}

async function migrateProfile(
  work: TenantWork,
  scope: AccessScope | undefined
) {
  const timezone = work.tenant.tz?.trim();
  const displayName = work.tenant.displayName?.trim();
  const current = scope ? await readUserProfile(scope) : undefined;
  const patch: UserProfilePatch = {};

  const hasName =
    current !== undefined &&
    (current.firstName !== null || current.lastName !== null);
  if (displayName && !hasName) {
    const [firstName, ...rest] = displayName.split(/\s+/u);
    if (firstName) patch.firstName = firstName;
    if (rest.length > 0) patch.lastName = rest.join(" ");
  }
  if (timezone && isSupportedTimeZone(timezone)) patch.timezone = timezone;

  const fields = Object.keys(patch);
  if (fields.length > 0 && scope && !work.options.dryRun) {
    await patchUserProfile(scope, patch);
  }
  return fields;
}

/**
 * Paid access moves forward only. A person who already bought a month here
 * keeps the later date, so a re-run — or an import that lands after the first
 * new payment — cannot shorten what they paid for.
 */
async function migratePaidUntil(
  work: TenantWork,
  scope: AccessScope | undefined
) {
  const { paidUntil } = work.tenant;
  if (paidUntil === undefined) return null;
  const until = new Date(paidUntil);
  if (Number.isNaN(until.getTime())) {
    throw new Error("the tenant's paidUntil is not a timestamp");
  }
  if (scope && !work.options.dryRun) {
    const updatedAt = new Date();
    await db
      .insert(billingAccounts)
      .values({ paidUntil: until, updatedAt, workspaceId: scope.workspaceId })
      .onConflictDoUpdate({
        set: { paidUntil: until, updatedAt },
        setWhere: sql`${billingAccounts.paidUntil} IS NULL OR ${billingAccounts.paidUntil} < ${until.toISOString()}::timestamptz`,
        target: billingAccounts.workspaceId,
      });
  }
  return until.toISOString();
}

async function migratePayments(
  work: TenantWork,
  scope: AccessScope | undefined
) {
  if (!scope || work.options.dryRun) return work.payments.length;
  /* oxlint-disable eslint/no-await-in-loop -- Payments are written in their recorded order so the stored history reads the same way it did in Convex. */
  for (const payment of work.payments) {
    await recordPayment(scope, {
      amountRub: wholeRoubles(payment.amountRub),
      createdAt: new Date(payment.createdAt),
      id: payment.yookassaId,
      paidUntilAfter:
        payment.paidUntilAfter === undefined
          ? null
          : new Date(payment.paidUntilAfter),
      status: payment.status,
    });
  }
  /* oxlint-enable eslint/no-await-in-loop */
  return work.payments.length;
}

async function migrateOrders(work: TenantWork, scope: AccessScope | undefined) {
  if (!scope || work.options.dryRun) return work.orders.length;
  /* oxlint-disable eslint/no-await-in-loop -- Orders are upserted one at a time; each lands on its own merchant order number. */
  for (const order of work.orders) {
    await recordOrder(scope, {
      createdAt: new Date(order.createdAt ?? order.creationTime),
      merchant: order.merchant,
      merchantOrderId: order.merchantOrderId,
      pickup: order.pickup ?? null,
      priceRub: wholeRoubles(order.priceRub),
      status: order.status,
      title: order.title,
    });
  }
  /* oxlint-enable eslint/no-await-in-loop */
  return work.orders.length;
}

/**
 * Binds the Telegram conversation to the imported account. A chat already
 * bound elsewhere — or an account already bound to a different chat — is left
 * exactly as it is and reported: taking a live conversation away from whoever
 * holds it is not something an import gets to do quietly.
 */
async function migrateTelegramIdentity(
  work: TenantWork,
  account: PhoneAccount | undefined,
  scope: AccessScope | undefined,
  notes: string[]
): Promise<TelegramOutcome> {
  const externalUserId = work.tenant.telegramUserId?.trim();
  const chatId = work.tenant.telegramChatId?.trim();
  if (!externalUserId || !chatId) return "none";
  if (!account || !scope) return "linked";

  const [boundChat] = await db
    .select({ userId: channelIdentities.userId })
    .from(channelIdentities)
    .where(
      and(
        eq(channelIdentities.channel, "telegram"),
        eq(channelIdentities.externalUserId, externalUserId)
      )
    )
    .limit(1);
  if (boundChat && boundChat.userId !== account.userId) {
    notes.push("the Telegram chat is already bound to another account");
    return "conflict";
  }

  const [boundAccount] = await db
    .select({ externalUserId: channelIdentities.externalUserId })
    .from(channelIdentities)
    .where(
      and(
        eq(channelIdentities.channel, "telegram"),
        eq(channelIdentities.userId, account.userId)
      )
    )
    .limit(1);
  if (boundAccount && boundAccount.externalUserId !== externalUserId) {
    notes.push("the account is already bound to a different Telegram chat");
    return "conflict";
  }

  if (!work.options.dryRun) {
    const linkedAt = new Date();
    const username = work.tenant.telegramUsername?.trim() ?? null;
    await db
      .insert(channelIdentities)
      .values({
        channel: "telegram",
        chatId,
        externalUserId,
        linkedAt,
        userId: account.userId,
        username,
        workspaceId: scope.workspaceId,
      })
      .onConflictDoUpdate({
        set: { chatId, linkedAt, username },
        target: [channelIdentities.channel, channelIdentities.externalUserId],
      });
  }
  return "linked";
}

/**
 * Buys this person a line on the new Photon project. The old project's numbers
 * do not carry over, so the assignment is stored in `onboarding_requests`,
 * which is also what makes a second run reuse the number instead of buying a
 * second one.
 */
async function migratePhotonLine(
  work: TenantWork,
  phoneNumber: string,
  notes: string[]
) {
  if (!work.options.registerPhoton) return null;

  const existing = await findOnboardingRequest(phoneNumber);
  if (existing) return existing.assignedPhoneNumber;
  if (work.options.dryRun) {
    notes.push("a Photon line would be registered");
    return null;
  }

  const assignedPhoneNumber = await createPhotonSharedUser(phoneNumber);
  return await recordOnboardingRequest({
    assignedPhoneNumber,
    ipHash: migrationCallerHash,
    phoneNumber,
  });
}

/**
 * Re-keys the vault: each item is decrypted with the old deployment's master
 * key and saved through this installation's vault service, which encrypts it
 * again under the installation key. Plaintext lives in one local variable and
 * is never logged, not even in a failure message.
 */
async function migrateVault(
  work: TenantWork,
  scope: AccessScope | undefined,
  notes: string[]
): Promise<VaultOutcome> {
  const { masterKey } = work;
  if (masterKey === undefined) return emptyVaultOutcome;

  const items = work.snapshot.vaultItems
    .filter((item) => item.tenantId === work.tenant.id)
    .toSorted((left, right) => left.createdAt - right.createdAt);
  if (items.length === 0) return emptyVaultOutcome;

  const held = scope ? await readHeldVaultKeys(scope) : new Set<string>();
  let created = 0;
  let existing = 0;
  let failed = 0;

  /* oxlint-disable eslint/no-await-in-loop -- Vault items are re-encrypted one at a time so a rejected item is reported on its own instead of failing the batch. */
  for (const item of items) {
    const key = vaultItemKey(item.kind, vaultItemLabel(item));
    if (held.has(key)) {
      existing += 1;
      continue;
    }
    try {
      const create = legacyVaultCreateItem(
        item.kind,
        vaultItemLabel(item),
        decryptLegacyVaultSecret(
          masterKey,
          item.tenantId,
          item.handle,
          vaultCiphertext(work, item)
        )
      );
      if (scope && !work.options.dryRun) await saveVaultItem(scope, create);
      held.add(key);
      created += 1;
    } catch (error) {
      failed += 1;
      notes.push(
        `vault item ${item.kind}/${vaultItemLabel(item)}: ${failureNote(error instanceof Error ? error : undefined)}`
      );
    }
  }
  /* oxlint-enable eslint/no-await-in-loop */

  return { created, existing, failed };
}

function vaultCiphertext(work: TenantWork, item: ConvexVaultItem) {
  const secret = work.snapshot.vaultSecrets.find(
    (row) => row.tenantId === item.tenantId && row.handle === item.handle
  );
  if (!secret) throw new Error("the export has no ciphertext for this item");
  return secret.ciphertext;
}

async function readHeldVaultKeys(scope: AccessScope) {
  const rows = await db
    .select({ kind: vaultItems.kind, label: vaultItems.label })
    .from(vaultItems)
    .where(eq(vaultItems.workspaceId, scope.workspaceId));
  return new Set(rows.map((row) => vaultItemKey(row.kind, row.label)));
}

/** A workspace holds one item per label and kind; that pair is the import key. */
function vaultItemKey(kind: string, label: string) {
  return JSON.stringify([kind, label]);
}

function vaultItemLabel(item: ConvexVaultItem) {
  return item.label.trim() || item.handle;
}

function wholeRoubles(amount: number) {
  return Math.max(0, Math.round(amount));
}

/**
 * One line about what went wrong. A driver error carries the failing statement
 * and its bound parameters over several lines, and those parameters are the
 * person's own data, so only the first line survives and any phone number left
 * in it is masked.
 */
function failureNote(error: Error | undefined) {
  const message = error?.message ?? "an unknown failure occurred";
  return redactPhoneNumbers(message.split("\n")[0] ?? message);
}

/** Masks anything shaped like an E.164 number wherever it appears in a line. */
function redactPhoneNumbers(line: string) {
  return line.replaceAll(
    /\+[1-9]\d{7,14}/gu,
    (phoneNumber) => `••••${phoneNumber.slice(-4)}`
  );
}

function accountOutcome(account: PhoneAccount | undefined): AccountOutcome {
  if (!account) return "new";
  return account.created ? "created" : "reused";
}

function skippedTenant(
  maskedPhoneNumber: string,
  reason: string
): TenantOutcome {
  return {
    account: "new",
    maskedPhoneNumber,
    notes: [reason],
    orders: 0,
    paidUntil: null,
    payments: 0,
    photonNumber: null,
    profileFields: [],
    status: "skipped",
    telegram: "none",
    vault: emptyVaultOutcome,
  };
}

/** Logs and summaries carry the last four digits and nothing more. */
function maskPhoneNumber(phoneNumber: string, tenantId: string) {
  const digits = phoneNumber.replaceAll(/\D/gu, "");
  return digits.length >= 4
    ? `••••${digits.slice(-4)}`
    : `convex:${tenantId.slice(-6)}`;
}

function formatTenantOutcome(outcome: TenantOutcome) {
  const parts = [
    outcome.maskedPhoneNumber.padEnd(12),
    outcome.status.padEnd(8),
    `account=${outcome.account}`,
    `profile=${outcome.profileFields.length > 0 ? outcome.profileFields.join("+") : "-"}`,
    `paid_until=${outcome.paidUntil ?? "-"}`,
    `payments=${String(outcome.payments)}`,
    `orders=${String(outcome.orders)}`,
    `telegram=${outcome.telegram}`,
    `vault=${String(outcome.vault.created)} new/${String(outcome.vault.existing)} existing/${String(outcome.vault.failed)} failed`,
  ];
  if (outcome.photonNumber) parts.push(`photon=${outcome.photonNumber}`);
  const line = parts.join("  ");
  return outcome.notes.length > 0
    ? `${line}\n${outcome.notes.map((note) => `    · ${note}`).join("\n")}`
    : line;
}

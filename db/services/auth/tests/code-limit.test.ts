import { readdir, readFile } from "node:fs/promises";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as schema from "@db/schema";
import type * as Photon from "@db/services/auth/photon";
import type * as Environment from "@shared/environment";

// A fresh PGlite with every migration applied takes seconds.
vi.setConfig({ testTimeout: 30_000 });

const mocks = vi.hoisted(() => ({
  sendPhotonText:
    vi.fn<(input: { message: string; to: string }) => Promise<void>>(),
}));

vi.mock("@shared/environment", async (importOriginal) => ({
  ...(await importOriginal<typeof Environment>()),
  localPhoneAuthBypassEnabled: false,
}));
vi.mock("@shared/photon/credentials", () => ({ photonConfigured: () => true }));
vi.mock("@db/services/installation-secrets", () => ({
  getInstallationSecrets: async () => ({
    betterAuthSecret: "sign-in-code-limit-test-secret-0123456789",
  }),
}));
vi.mock("@db/services/auth/photon", async (importOriginal) => ({
  ...(await importOriginal<typeof Photon>()),
  sendPhotonText: mocks.sendPhotonText,
}));

const databases: PGlite[] = [];
const start = new Date("2026-10-12T10:00:00Z");
const minutes = (count: number) => count * 60_000;

afterEach(async () => {
  vi.restoreAllMocks();
  mocks.sendPhotonText.mockReset();
  await Promise.all(databases.splice(0).map((database) => database.close()));
});

async function withDatabase() {
  vi.resetModules();
  const client = new PGlite();
  databases.push(client);
  await applyMigrations(client);
  // SAFETY: PGlite implements the query-builder surface these services use despite using a different Drizzle driver.
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- This test swaps only the driver while retaining the shared Drizzle schema and query-builder contract.
  const database = drizzle(client, { schema }) as never;
  const Database = await import("@db");
  vi.spyOn(Database, "db", "get").mockReturnValue(database);
}

async function codeSends() {
  await withDatabase();
  return import("@db/services/auth/code-sends");
}

/** Posts to the sign-in endpoints as a visitor at `address` would. */
async function signIn() {
  await withDatabase();
  const { getAuth } = await import("@db/services/auth");
  const auth = await getAuth();
  const { applicationOrigin } = await import("@shared/environment/origin");
  const origin = new URL(applicationOrigin()).origin;
  const post = async (
    path: string,
    body: { readonly code?: string; readonly phoneNumber: string },
    address: string
  ) =>
    auth.handler(
      new Request(`${origin}/api/auth${path}`, {
        body: JSON.stringify(body),
        headers: {
          "content-type": "application/json",
          origin,
          "x-forwarded-for": address,
        },
        method: "POST",
      })
    );
  return {
    send: async (phoneNumber: string, address: string) =>
      (await post("/phone-number/send-otp", { phoneNumber }, address)).status,
    verify: async (phoneNumber: string, code: string, address: string) =>
      (await post("/phone-number/verify", { code, phoneNumber }, address))
        .status,
  };
}

/** Runs the requests one after another, as a person or a script sends them. */
async function inTurn<TItem>(
  items: readonly TItem[],
  request: (item: TItem) => Promise<number | boolean>
) {
  const answers: (number | boolean)[] = [];
  for (const item of items) {
    // oxlint-disable-next-line eslint/no-await-in-loop -- Each request waits for the one before it.
    const answer = await request(item);
    answers.push(answer);
  }
  return answers;
}

function lastCode() {
  const message = mocks.sendPhotonText.mock.calls.at(-1)?.[0].message ?? "";
  return /\d{6}/u.exec(message)?.[0] ?? "";
}

describe("sign-in code limit", () => {
  it("sends a number three codes in ten minutes, whatever the address", async () => {
    mocks.sendPhotonText.mockResolvedValue(undefined);
    const { send } = await signIn();

    const statuses = await inTurn(
      ["203.0.113.1", "203.0.113.2", "203.0.113.3", "203.0.113.4"],
      async (address) => send("+79990000001", address)
    );

    expect(statuses).toEqual([200, 200, 200, 429]);
    expect(mocks.sendPhotonText).toHaveBeenCalledTimes(3);
  });

  it("keeps the code the person has when a request is refused", async () => {
    mocks.sendPhotonText.mockResolvedValue(undefined);
    const { send, verify } = await signIn();
    await inTurn(["198.51.100.1", "198.51.100.2", "198.51.100.3"], (address) =>
      send("+79990000004", address)
    );
    const code = lastCode();

    await expect(send("+79990000004", "198.51.100.9")).resolves.toBe(429);

    await expect(verify("+79990000004", code, "198.51.100.3")).resolves.toBe(
      200
    );
  });

  it("stops one address flooding many numbers", async () => {
    mocks.sendPhotonText.mockResolvedValue(undefined);
    const { send } = await signIn();

    const statuses = await inTurn(
      Array.from({ length: 11 }, (_, index) => index),
      (index) =>
        send(`+7999000${String(index).padStart(4, "0")}`, "198.51.100.7")
    );

    expect(statuses).toEqual([...Array.from({ length: 10 }, () => 200), 429]);
    expect(mocks.sendPhotonText).toHaveBeenCalledTimes(10);
  });

  it("opens the number again once the window passes, up to ten a day", async () => {
    const { claimSignInCodeSend } = await codeSends();
    const claim = async (at: number) =>
      claimSignInCodeSend({
        address: null,
        now: new Date(start.getTime() + minutes(at)),
        phoneNumber: "+79990000002",
      });

    // Three right away, a refusal, then three every 11 minutes.
    const answers = await inTurn(
      [0, 1, 2, 3, 11, 12, 13, 22, 23, 24, 33, 34],
      claim
    );

    // The tenth code of the day goes out; the eleventh waits for tomorrow.
    expect(answers).toEqual(
      [true, true, true, false]
        .concat([true, true, true], [true, true, true])
        .concat([true, false])
    );
    await expect(claim(24 * 60 + 1)).resolves.toBe(true);
  });

  it("gives the last code to only one of two requests at once", async () => {
    const { claimSignInCodeSend } = await codeSends();
    const claim = async () =>
      claimSignInCodeSend({
        address: "203.0.113.9",
        now: start,
        phoneNumber: "+79990000003",
      });

    const answers = await Promise.all([claim(), claim(), claim(), claim()]);

    expect(answers.filter(Boolean)).toHaveLength(3);
  });
});

async function applyMigrations(database: PGlite) {
  const directory = new URL("../../../migrations/", import.meta.url);
  const names = (await readdir(directory))
    .filter((name) => name.endsWith(".sql"))
    .toSorted();
  /* oxlint-disable eslint/no-await-in-loop -- SQL migration statements must execute in file order. */
  for (const name of names) {
    const migration = await readFile(new URL(name, directory), "utf8");
    for (const statement of migration.split("--> statement-breakpoint")) {
      if (statement.trim()) await database.exec(statement);
    }
  }
  /* oxlint-enable eslint/no-await-in-loop */
}

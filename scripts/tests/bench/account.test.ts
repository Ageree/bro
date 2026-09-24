import { mkdtemp, readFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  caseFixtureSets,
  fixtureSets,
  type SeedContext,
} from "../../bench/account/catalog.ts";
import {
  composioProxy,
  findGoogleAccount,
} from "../../bench/account/composio.ts";
import { googleAccount } from "../../bench/account/google.ts";
import { readManifest } from "../../bench/account/manifest.ts";
import { buildMessage, encodeHeaderText } from "../../bench/account/mime.ts";
import {
  caseFixtureState,
  cleanFixtures,
  describeFixtures,
  planFixtures,
  seedFixtures,
} from "../../bench/account/seed.ts";
import { fakeComposio, readRawLetter } from "./fake-composio.ts";

afterEach(() => {
  vi.unstubAllGlobals();
});

const apiKey = "test-composio-key";
const mailbox = "bench.tester@gmail.com";
// A Thursday: «в четверг» in a letter means the next one, a week ahead.
const now = new Date("2026-09-24T12:00:00+03:00");
const context: SeedContext = {
  mailbox,
  now,
  timeZone: "Europe/Moscow",
  track: "1094857362",
};
const built = Object.entries(fixtureSets).map(([id, set]) => ({
  id,
  content: set.build(context),
}));

const reserved = /(?:^|\.)example\.(?:com|org|net)$/u;

describe("fixture catalog", () => {
  it("writes to and from nobody but the tester and reserved domains", () => {
    const addresses = built.flatMap((set) =>
      set.content.letters.flatMap((letter) => [
        letter.from.address,
        letter.to.address,
      ])
    );
    const strangers = addresses.filter((address) => {
      const [local = "", domain = ""] = address.split("@");
      const own =
        domain === "gmail.com" && /^bench\.tester(?:\+[a-z]+)?$/u.test(local);
      return !own && !reserved.test(domain);
    });
    expect(strangers).toEqual([]);
  });

  it("links only to reserved domains, the phishing letter included", () => {
    const hosts = built.flatMap((set) =>
      set.content.letters.flatMap((letter) =>
        [
          ...`${letter.body} ${letter.unsubscribe ?? ""}`.matchAll(
            /https?:\/\/([^/\s>]+)/gu
          ),
        ].map((match) => match[1] ?? "")
      )
    );
    expect(hosts.length).toBeGreaterThan(5);
    expect(hosts.filter((host) => !reserved.test(host))).toEqual([]);
  });

  it("dates old letters in the past and fills the calendar only ahead", () => {
    const future = built.flatMap((set) =>
      set.content.letters.flatMap((letter) =>
        letter.sentAt !== "on-arrival" &&
        letter.sentAt.getTime() >= now.getTime()
          ? [`${set.id}/${letter.key}`]
          : []
      )
    );
    expect(future).toEqual([]);
    const events = built.flatMap((set) => set.content.events);
    expect(events.length).toBeGreaterThan(20);
    expect(
      events.filter(
        (event) =>
          event.start.getTime() <= now.getTime() ||
          event.end.getTime() <= event.start.getTime()
      )
    ).toEqual([]);
  });

  it("puts the flight tomorrow and the dentist and Thursday where the tests say", () => {
    const flight = fixtureSets["flight-ru"].build(context);
    expect(flight.events[0]?.start.toISOString()).toBe(
      "2026-09-25T04:05:00.000Z"
    );
    expect(flight.letters[0]?.subject).toBe(
      "Маршрутная квитанция: Москва — Сочи, 25.09"
    );
    const dentist = fixtureSets["dentist-friday"].build(context);
    expect(dentist.letters[1]?.body).toContain("пятница, 25.09.2026, 18:30");
    const irina = fixtureSets["irina-thread"].build(context);
    expect(irina.letters.at(-1)?.body).toContain(
      "в четверг, 01.10, в 13:00 по Екатеринбургу"
    );
  });

  it("leaves Thursday afternoon with a free half hour between meetings", () => {
    const week = fixtureSets["busy-week-en"].build(context);
    expect(week.expect).toContain(
      "free Thu Oct 1: 12:00–13:00, 14:30–15:00, 16:30–19:00"
    );
    expect(week.events.every((event) => event.title.length > 0)).toBe(true);
  });

  it("adds up the repair receipts the expectation names", () => {
    const repair = fixtureSets["repair-receipts"].build(context);
    const counted = repair.letters.filter(
      (letter) =>
        letter.sentAt !== "on-arrival" &&
        letter.sentAt.getTime() >= Date.parse("2026-05-01T00:00:00+03:00") &&
        !["groceries", "tiles-order"].includes(letter.key)
    );
    const total = counted.reduce((sum, letter) => {
      const amount = /Итого: ([\d ]+) ₽/u.exec(letter.body)?.[1] ?? "0";
      return sum + Number(amount.replaceAll(" ", ""));
    }, 0);
    expect(total).toBe(49_840);
    expect(repair.expect[0]).toContain("итого 49 840 ₽");
  });

  it("marks the Drive passport as a specimen", () => {
    const [passport] =
      fixtureSets["passport-document"].build(context).documents;
    expect(passport?.content.startsWith("SPECIMEN")).toBe(true);
  });

  it("maps every case to sets that exist", () => {
    for (const sets of caseFixtureSets.values()) {
      for (const set of sets) expect(Object.keys(fixtureSets)).toContain(set);
    }
  });
});

describe("buildMessage", () => {
  it("encodes Cyrillic headers in short words and the body as base64", () => {
    const subject = "Маршрутная квитанция: Москва — Сочи, 25.09, рейс DP 405";
    const encoded = encodeHeaderText(subject);
    for (const word of encoded.split("\r\n ")) {
      expect(word.length).toBeLessThanOrEqual(75);
    }
    const raw = Buffer.from(
      buildMessage({
        body: "Здравствуйте!\nВылет в 07:05.",
        date: "Thu, 24 Sep 2026 12:00:00 +0300",
        fixture: "flight-ru/itinerary",
        from: { address: "booking@pobeda.example.com", name: "Победа" },
        inReplyTo: undefined,
        listUnsubscribe: undefined,
        messageId: "<flight-ru.itinerary@bro-bench.example.com>",
        subject,
        to: { address: mailbox },
      })
    ).toString("base64url");
    const letter = readRawLetter(raw);
    expect(letter.headers.get("subject")).toBe(subject);
    expect(letter.headers.get("x-bro-bench")).toBe("flight-ru/itinerary");
    expect(letter.body).toBe("Здравствуйте!\r\nВылет в 07:05.");
    expect(letter.text).not.toMatch(/[^\r]\n/u);
  });
});

describe("findGoogleAccount", () => {
  it("finds the tester's googlesuper connection under either form of the user id", async () => {
    const fake = fakeComposio({
      accounts: [{ id: "ca_1", status: "ACTIVE", userId: "better-auth:u1" }],
      apiKey,
      mailbox,
    });
    vi.stubGlobal("fetch", fake.fetch);

    await expect(findGoogleAccount(apiKey, "u1")).resolves.toBe("ca_1");
    const [query] = fake.accountQueries;
    expect(query?.get("toolkit_slugs")).toBe("googlesuper");
    expect(query?.get("statuses")).toBe("ACTIVE");
    expect(query?.get("user_ids")).toBe("u1,better-auth:u1");
  });

  it("refuses to guess between two connections or without one", async () => {
    const fake = fakeComposio({
      accounts: [
        { id: "ca_1", status: "ACTIVE", userId: "u1" },
        { id: "ca_2", status: "ACTIVE", userId: "better-auth:u1" },
      ],
      apiKey,
      mailbox,
    });
    vi.stubGlobal("fetch", fake.fetch);

    await expect(findGoogleAccount(apiKey, "u1")).rejects.toThrow(/--account/u);
    await expect(findGoogleAccount(apiKey, "u2")).rejects.toThrow(
      /No ACTIVE googlesuper/u
    );
  });

  it("says what Composio said about a bad key", async () => {
    vi.stubGlobal(
      "fetch",
      fakeComposio({ accounts: [], apiKey, mailbox }).fetch
    );
    await expect(findGoogleAccount("wrong", "u1")).rejects.toThrow(/401/u);
  });
});

async function seeded(
  caseIds: readonly string[],
  options: { readonly spreadMs?: number } = {}
) {
  const fake = fakeComposio({ accounts: [], apiKey, mailbox });
  vi.stubGlobal("fetch", fake.fetch);
  const manifestPath = join(
    await mkdtemp(join(tmpdir(), "bench-fixtures-")),
    "fixtures.json"
  );
  const google = googleAccount(composioProxy(apiKey, "ca_1"));
  const log: string[] = [];
  const seed = (ids: readonly string[]) =>
    seedFixtures({
      account: "ca_1",
      context,
      google,
      log: (line) => log.push(line),
      manifestPath,
      plan: planFixtures(ids, context),
      spreadMs: options.spreadMs ?? 0,
    });
  await seed(caseIds);
  const clean = (ids: readonly string[] | undefined) =>
    cleanFixtures({
      caseIds: ids,
      dryRun: false,
      google: (account) => googleAccount(composioProxy(apiKey, account)),
      log: (line) => log.push(line),
      manifestPath,
    });
  return { clean, fake, log, manifestPath, seed };
}

describe("seedFixtures", () => {
  it("puts d09's thread into the tester's mailbox, replies in their threads", async () => {
    const { fake, manifestPath } = await seeded(["d09-email"]);

    const letters = [...fake.letters.values()].map((stored) => ({
      read: readRawLetter(stored.raw),
      stored,
    }));
    expect(letters).toHaveLength(8);
    const label = [...fake.labels].find(
      ([, name]) => name === "bro-bench"
    )?.[0];
    expect(label).toBeDefined();
    const byKey = (key: string) =>
      letters.find(
        (letter) =>
          letter.read.headers.get("x-bro-bench") === `irina-thread/${key}`
      );
    expect(byKey("contract")?.stored.labelIds).toEqual(["SENT", label]);
    expect(byKey("thursday")?.stored.labelIds).toEqual([
      "INBOX",
      label,
      "UNREAD",
    ]);
    expect(byKey("thursday")?.stored.dated).toBe("dateHeader");
    // A reply sits in the thread of the letter it answers.
    expect(byKey("contract-reply")?.stored.threadId).toBe(
      byKey("contract")?.stored.threadId
    );
    expect(byKey("contract-reply")?.read.headers.get("in-reply-to")).toBe(
      "<irina-thread.contract@bro-bench.example.com>"
    );
    expect(byKey("thursday")?.read.headers.get("from")).toContain(
      "<bench.tester+irina@gmail.com>"
    );
    // Her letters are dated on her clock, two hours ahead of Moscow.
    expect(byKey("thursday")?.read.headers.get("date")).toMatch(/\+0500$/u);

    const inserted = fake.calls.filter((call) =>
      call.endpoint.includes("/calendar/")
    );
    expect(inserted.length).toBeGreaterThan(8);
    for (const call of inserted) {
      expect(call.parameters).toEqual([
        { name: "sendUpdates", type: "query", value: "none" },
      ]);
      expect(call.body).not.toHaveProperty("attendees");
    }

    const manifest = await readManifest(manifestPath);
    expect(manifest.items).toHaveLength(8 + fake.events.size);
    expect(manifest.sets.map((set) => [set.set, set.complete])).toEqual([
      ["irina-thread", true],
      ["busy-week", true],
    ]);
    expect((await stat(manifestPath)).mode & 0o777).toBe(0o600);
    expect(await readFile(manifestPath, "utf8")).not.toContain(apiKey);
  });

  it("does not insert a set twice, and files a second case under it", async () => {
    const { fake, log, manifestPath, seed } = await seeded(["d09-email"]);
    const before = fake.calls.length;

    await seed(["d12-routine"]);

    const newCalls = fake.calls.slice(before);
    expect(
      newCalls.filter((call) => call.endpoint.includes("/calendar/"))
    ).toEqual([]);
    expect(log.some((line) => line.startsWith("busy-week: уже засеяно"))).toBe(
      true
    );
    const manifest = await readManifest(manifestPath);
    expect(manifest.sets.find((set) => set.set === "busy-week")?.cases).toEqual(
      ["d09-email", "d12-routine"]
    );
    expect(caseFixtureState(manifest, "d12-routine").missing).toEqual([]);
  });

  it("lets «arriving» letters come in one by one, dated when they land", async () => {
    const { fake } = await seeded(["d11-restraint"], { spreadMs: 90 });

    const letters = [...fake.letters.values()];
    expect(letters).toHaveLength(4);
    expect(letters.every((letter) => letter.dated === "receivedTime")).toBe(
      true
    );
    expect(
      letters.map((letter) =>
        readRawLetter(letter.raw).headers.get("x-bro-bench")
      )
    ).toEqual([
      "evening-ru/boss",
      "evening-ru/parcel",
      "evening-ru/friend",
      "evening-ru/phishing",
    ]);
  });

  it("uploads and names the Drive specimen for D14", async () => {
    const { fake } = await seeded(["d14_chain"]);

    const [file] = [...fake.files.values()];
    expect(file?.name).toBe("Passport — IVANOV IVAN (SPECIMEN).txt");
    expect(file?.content).toContain("Not a real passport");
  });
});

describe("cleanFixtures", () => {
  it("removes what only the cleaned case needed and keeps a shared set", async () => {
    const { clean, fake, manifestPath, seed } = await seeded(["d09-email"]);
    await seed(["d12-routine"]);
    const eventsBefore = fake.events.size;

    await clean(["d09-email"]);

    const left = [...fake.letters.values()].map(
      (letter) => readRawLetter(letter.raw).headers.get("x-bro-bench") ?? ""
    );
    expect(left.some((key) => key.startsWith("irina-thread/"))).toBe(false);
    expect(
      left.filter((key) => key.startsWith("awaiting-reply/"))
    ).toHaveLength(3);
    expect(fake.events.size).toBe(eventsBefore);
    const manifest = await readManifest(manifestPath);
    expect(manifest.sets.map((set) => set.set)).toEqual([
      "busy-week",
      "awaiting-reply",
    ]);

    await clean(undefined);

    expect(fake.letters.size).toBe(0);
    expect(fake.events.size).toBe(0);
    expect([...fake.labels.values()]).toEqual(["Работа"]);
    expect(await readManifest(manifestPath)).toMatchObject({
      items: [],
      labels: [],
      sets: [],
    });
  });

  it("trashes a letter the grant cannot delete, and forgets it", async () => {
    const fake = fakeComposio({
      accounts: [],
      apiKey,
      letterDeleteStatus: 403,
      mailbox,
    });
    vi.stubGlobal("fetch", fake.fetch);
    const manifestPath = join(
      await mkdtemp(join(tmpdir(), "bench-fixtures-")),
      "f.json"
    );
    const google = googleAccount(composioProxy(apiKey, "ca_1"));
    await seedFixtures({
      account: "ca_1",
      context,
      google,
      log: () => undefined,
      manifestPath,
      plan: planFixtures(["d14-permissions"], context),
      spreadMs: 0,
    });

    await cleanFixtures({
      caseIds: undefined,
      dryRun: false,
      google: () => google,
      log: () => undefined,
      manifestPath,
    });

    expect(fake.trashed.size).toBe(1);
    expect((await readManifest(manifestPath)).items).toEqual([]);
  });
});

describe("describeFixtures", () => {
  it("lists what a dry run would insert, with the checks", () => {
    const lines = describeFixtures(
      planFixtures(["d18-chain"], context),
      "Europe/Moscow"
    );
    expect(lines[0]).toBe(
      "dentist-friday — запись к стоматологу на пятницу (кейсы: d18-chain)"
    );
    expect(
      lines.some((line) =>
        line.includes("«Вы записаны на приём 25.09» [INBOX]")
      )
    ).toBe(true);
    expect(
      lines.some((line) =>
        line.startsWith("  проверить: приём в пятницу 25.09")
      )
    ).toBe(true);
  });
});

import { setTimeout as sleep } from "node:timers/promises";
import { clockTime, mailDate, shortDate, localDay } from "../clock.ts";
import { isoWithOffset } from "../journal.ts";
import {
  caseFixtureSets,
  fixtureSets,
  type FixtureLetter,
  type FixtureSetContent,
  type FixtureSetId,
  type SeedContext,
} from "./catalog.ts";
import type { CalendarEventBody, googleAccount } from "./google.ts";
import {
  readManifest,
  setOf,
  writeManifest,
  type FixtureManifest,
} from "./manifest.ts";
import { base64Url, buildMessage, type MailParty } from "./mime.ts";

/**
 * Seeds the fixture sets the chosen cases need into the tester's account
 * and removes them again. Each set is built once however many cases share
 * it, each item is written to the manifest as soon as Google has it, and an
 * item already in the manifest is never inserted twice.
 */

const fixtureLabel = "bro-bench";

type GoogleAccount = ReturnType<typeof googleAccount>;

interface PlannedSet {
  readonly cases: readonly string[];
  readonly content: FixtureSetContent;
  readonly id: FixtureSetId;
}

/** The sets the cases need, each built once, in the order cases name them. */
export function planFixtures(
  caseIds: readonly string[],
  context: SeedContext
): PlannedSet[] {
  const planned = new Map<FixtureSetId, string[]>();
  for (const caseId of caseIds) {
    for (const set of caseFixtureSets.get(caseId) ?? []) {
      planned.set(set, [...(planned.get(set) ?? []), caseId]);
    }
  }
  return [...planned].map(([id, cases]) => ({
    cases,
    content: fixtureSets[id].build(context),
    id,
  }));
}

const messageIdOf = (set: string, key: string) =>
  `<${set}.${key}@bro-bench.example.com>`;

/** A party as a person reads it; the header form is for Gmail only. */
const readable = (party: MailParty) =>
  party.name ? `${party.name} <${party.address}>` : party.address;

const moment = (date: Date, timeZone: string) =>
  `${shortDate(localDay(date, timeZone))} ${clockTime(date, timeZone)}`;

function letterSummary(letter: FixtureLetter, sentAt: string) {
  const labels = [
    letter.folder === "sent" ? "SENT" : "INBOX",
    ...(letter.unread ? ["UNREAD"] : []),
  ].join(" ");
  return `письмо ${sentAt} ${readable(letter.from)} → ${readable(letter.to)}: «${letter.subject}» [${labels}]`;
}

/** What seeding the plan would put where, for `--dry-run` and the log. */
export function describeFixtures(
  plan: readonly PlannedSet[],
  timeZone: string
) {
  return plan.flatMap((set) => [
    `${set.id} — ${fixtureSets[set.id].title} (кейсы: ${set.cases.join(", ")})`,
    ...set.content.letters.map(
      (letter) =>
        `  ${letterSummary(
          letter,
          letter.sentAt === "on-arrival"
            ? "при засеве"
            : moment(letter.sentAt, timeZone)
        )}`
    ),
    ...set.content.events.map(
      (event) =>
        `  событие ${moment(event.start, timeZone)}–${clockTime(event.end, timeZone)} «${event.title}»${event.location ? ` (${event.location})` : ""}`
    ),
    ...set.content.documents.map(
      (document) => `  файл в Диске «${document.name}»`
    ),
    ...set.content.expect.map((line) => `  проверить: ${line}`),
  ]);
}

function eventBody(
  set: string,
  event: FixtureSetContent["events"][number]
): CalendarEventBody {
  return {
    // Graphite: the tester sees at a glance which events the seed made.
    colorId: "8",
    description: event.description,
    end: {
      dateTime: isoWithOffset(event.end, event.timeZone),
      timeZone: event.timeZone,
    },
    extendedProperties: { private: { broBench: `${set}/${event.key}` } },
    location: event.location,
    start: {
      dateTime: isoWithOffset(event.start, event.timeZone),
      timeZone: event.timeZone,
    },
    summary: event.title,
  };
}

export async function seedFixtures(options: {
  readonly account: string;
  readonly context: SeedContext;
  readonly google: GoogleAccount;
  readonly log: (line: string) => void;
  readonly manifestPath: string;
  readonly plan: readonly PlannedSet[];
  /** Spreads «arriving» letters over this long instead of inserting them at once. */
  readonly spreadMs: number;
}) {
  const { account, context, google, log, manifestPath, plan } = options;
  const manifest = await readManifest(manifestPath);
  const save = () => writeManifest(manifestPath, manifest);
  const now = () => isoWithOffset(new Date(), context.timeZone);
  const has = (key: string) =>
    manifest.items.some((item) => item.account === account && item.key === key);

  const label = await google.ensureLabel(fixtureLabel);
  if (
    !manifest.labels.some(
      (known) => known.account === account && known.id === label.id
    )
  ) {
    manifest.labels.push({ account, created: label.created, id: label.id });
    await save();
  }

  const pending: PlannedSet[] = [];
  for (const set of plan) {
    const known = manifest.sets.find(
      (entry) => entry.account === account && entry.set === set.id
    );
    if (known) {
      known.cases = [...new Set([...known.cases, ...set.cases])];
    }
    if (known?.complete) {
      log(
        `${set.id}: уже засеяно ${known.seededAt}; заново — pnpm bench fixtures clean --case ${set.cases.join(",")} и seed`
      );
      continue;
    }
    if (!known) {
      manifest.sets.push({
        account,
        cases: [...set.cases],
        complete: false,
        expect: [...set.content.expect],
        mailbox: context.mailbox,
        seededAt: now(),
        set: set.id,
      });
    }
    pending.push(set);
  }
  await save();

  const insertLetter = async (set: PlannedSet, letter: FixtureLetter) => {
    const key = `${set.id}/${letter.key}`;
    if (has(key)) return;
    const sentAt = letter.sentAt === "on-arrival" ? new Date() : letter.sentAt;
    const parent = letter.replyTo
      ? manifest.items.find(
          (item) =>
            item.account === account &&
            item.key === `${set.id}/${letter.replyTo ?? ""}`
        )
      : undefined;
    const raw = base64Url(
      buildMessage({
        body: letter.body,
        date: mailDate(sentAt, letter.senderZone ?? context.timeZone),
        fixture: key,
        from: letter.from,
        inReplyTo:
          parent && letter.replyTo
            ? messageIdOf(set.id, letter.replyTo)
            : undefined,
        listUnsubscribe: letter.unsubscribe,
        messageId: messageIdOf(set.id, letter.key),
        subject: letter.subject,
        to: letter.to,
      })
    );
    const created = await google.insertLetter({
      dated: letter.sentAt === "on-arrival" ? "insertion" : "header",
      labelIds:
        letter.folder === "sent"
          ? ["SENT", label.id]
          : ["INBOX", label.id, ...(letter.unread ? ["UNREAD"] : [])],
      raw,
      threadId: parent?.threadId,
    });
    manifest.items.push({
      account,
      createdAt: now(),
      id: created.id,
      key,
      kind: "letter",
      summary: letterSummary(letter, moment(sentAt, context.timeZone)),
      threadId: created.threadId,
    });
    await save();
    log(`  + ${letterSummary(letter, moment(sentAt, context.timeZone))}`);
  };

  // Old letters, events and files first; letters that «arrive» go last so a
  // spread over the evening starts when everything else is in place.
  const arrivals: [PlannedSet, FixtureLetter][] = [];
  for (const set of pending) {
    log(`${set.id}: ${fixtureSets[set.id].title}`);
    for (const letter of set.content.letters) {
      if (letter.sentAt === "on-arrival") arrivals.push([set, letter]);
      // oxlint-disable-next-line eslint/no-await-in-loop -- a reply needs its thread from the letter before it
      else await insertLetter(set, letter);
    }
    for (const event of set.content.events) {
      const key = `${set.id}/${event.key}`;
      if (has(key)) continue;
      // oxlint-disable-next-line eslint/no-await-in-loop -- one item at a time keeps the manifest exact after a failure
      const id = await google.insertEvent(eventBody(set.id, event));
      const summary = `событие ${moment(event.start, event.timeZone)} «${event.title}»`;
      manifest.items.push({
        account,
        createdAt: now(),
        id,
        key,
        kind: "event",
        summary,
      });
      // oxlint-disable-next-line eslint/no-await-in-loop -- saved after each item
      await save();
      log(`  + ${summary}`);
    }
    for (const document of set.content.documents) {
      const key = `${set.id}/${document.key}`;
      if (has(key)) continue;
      // oxlint-disable-next-line eslint/no-await-in-loop -- one item at a time keeps the manifest exact after a failure
      const id = await google.uploadDocument({
        content: document.content,
        description:
          "bro-bench: тестовый файл бенчмарка, не настоящий документ",
        mediaType: document.mediaType,
        name: document.name,
        properties: { broBench: key },
      });
      manifest.items.push({
        account,
        createdAt: now(),
        id,
        key,
        kind: "document",
        summary: `файл «${document.name}»`,
      });
      // oxlint-disable-next-line eslint/no-await-in-loop -- saved after each item
      await save();
      log(`  + файл «${document.name}»`);
    }
  }
  const gap =
    arrivals.length > 1 ? options.spreadMs / (arrivals.length - 1) : 0;
  for (const [index, [set, letter]] of arrivals.entries()) {
    if (index > 0 && gap > 0) {
      log(`  … следующее письмо через ${String(Math.round(gap / 60_000))} мин`);
      // oxlint-disable-next-line eslint/no-await-in-loop -- the spread is the point: letters arrive one by one
      await sleep(gap);
    }
    // oxlint-disable-next-line eslint/no-await-in-loop -- see above
    await insertLetter(set, letter);
  }

  for (const set of pending) {
    const entry = manifest.sets.find(
      (known) => known.account === account && known.set === set.id
    );
    if (entry) entry.complete = true;
  }
  await save();
}

/**
 * What a case's run record should say about its fixtures: which sets are
 * in the account and what to check them against, which are missing, and
 * when seeding began (where `observe` starts reading a conversation).
 */
export function caseFixtureState(manifest: FixtureManifest, caseId: string) {
  const sets = caseFixtureSets.get(caseId) ?? [];
  const seeded = manifest.sets.filter(
    (entry) => entry.complete && sets.some((set) => set === entry.set)
  );
  const starts = seeded.map((entry) => Date.parse(entry.seededAt));
  return {
    missing: sets.filter((set) => !seeded.some((entry) => entry.set === set)),
    notes: seeded.map(
      (entry) =>
        `заготовка ${entry.set} (засеяна ${entry.seededAt}): ${entry.expect.join("; ")}`
    ),
    seededAt: starts.length > 0 ? new Date(Math.min(...starts)) : undefined,
  };
}

/**
 * Removes what the seed created: everything, or what only the given cases
 * still need. A set another case still holds stays.
 */
export async function cleanFixtures(options: {
  readonly caseIds: readonly string[] | undefined;
  readonly dryRun: boolean;
  readonly google: (account: string) => GoogleAccount;
  readonly log: (line: string) => void;
  readonly manifestPath: string;
}) {
  const { log } = options;
  const manifest = await readManifest(options.manifestPath);
  const released = new Set<string>();
  if (options.caseIds) {
    const leaving = new Set(options.caseIds);
    const wanted = new Set<string>(
      options.caseIds.flatMap((caseId) => caseFixtureSets.get(caseId) ?? [])
    );
    for (const entry of manifest.sets) {
      entry.cases = entry.cases.filter((caseId) => !leaving.has(caseId));
    }
    const held = new Set(
      manifest.sets
        .filter((entry) => entry.cases.length > 0)
        .map((entry) => `${entry.account} ${entry.set}`)
    );
    for (const item of manifest.items) {
      const set = setOf(item.key);
      if (wanted.has(set) && !held.has(`${item.account} ${set}`)) {
        released.add(`${item.account} ${item.key}`);
      }
    }
  } else {
    for (const item of manifest.items) {
      released.add(`${item.account} ${item.key}`);
    }
  }
  const doomed = manifest.items.filter((item) =>
    released.has(`${item.account} ${item.key}`)
  );
  if (doomed.length === 0) log("Удалять нечего.");
  for (const item of doomed) {
    if (options.dryRun) {
      log(`  - ${item.summary}`);
      continue;
    }
    const google = options.google(item.account);
    // oxlint-disable-next-line eslint/no-await-in-loop -- one removal at a time keeps the manifest exact after a failure
    const outcome = await (item.kind === "letter"
      ? google.removeLetter(item.id)
      : item.kind === "event"
        ? google.removeEvent(item.id)
        : google.removeDocument(item.id));
    manifest.items = manifest.items.filter((known) => known !== item);
    // oxlint-disable-next-line eslint/no-await-in-loop -- saved after each removal
    await writeManifest(options.manifestPath, manifest);
    log(
      `  - ${item.summary}${outcome === "deleted" ? "" : ` (${outcome === "gone" ? "уже не было" : "в корзине"})`}`
    );
  }
  if (options.dryRun) return;
  manifest.sets = manifest.sets.filter(
    (entry) =>
      entry.cases.length > 0 &&
      manifest.items.some(
        (item) =>
          item.account === entry.account && setOf(item.key) === entry.set
      )
  );
  // A label the seed created goes once nothing of the seed is left in it.
  const accounts = new Set(manifest.items.map((item) => item.account));
  for (const label of manifest.labels.filter(
    (known) => !accounts.has(known.account)
  )) {
    if (label.created) {
      // oxlint-disable-next-line eslint/no-await-in-loop -- one account at a time
      await options.google(label.account).removeLabel(label.id);
    }
    manifest.labels = manifest.labels.filter((known) => known !== label);
    log(
      `  - ярлык ${fixtureLabel}${label.created ? "" : " (был до засева, оставлен)"}`
    );
  }
  await writeManifest(options.manifestPath, manifest);
}

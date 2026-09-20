/**
 * `npm run journeys` — every user journey the product has, replayed offline.
 *
 * A journey is one story told step by step over the pure policy modules: what
 * the person typed, what the page was showing, what the Cloud run came back
 * with, what Bro is then allowed to say. The output of a step is the input of
 * the next, so a green journey means the CHAIN holds, not that a regex still
 * matches. That is the half a live e2e run normally owns and that nothing here
 * could otherwise check without a deployed instance and a wallet full of
 * secrets.
 *
 * Two modes:
 *   npm run journeys        — run everything, print every journey and a summary
 *   npm run journeys:check  — stop at the first real failure (CI)
 *
 * A journey marked `knownGap` describes behaviour the product does NOT have.
 * It still runs and still prints, but it cannot turn the suite red: the owner
 * decides whether to close the gap, and until then the rest of the net has to
 * stay usable. Exit code 2 (never 0) is reserved for a gap that HEALED — the
 * product caught up with the story and the marker is now a lie.
 */

import { GROUPS, runAll, type Journey } from "./lib/journeys/runner.ts";
import { APPS } from "./lib/journeys/apps.ts";
import { MAIL } from "./lib/journeys/mail.ts";
import { CALENDAR } from "./lib/journeys/calendar.ts";
import { ORDERS } from "./lib/journeys/orders.ts";
import { PAY } from "./lib/journeys/pay.ts";
import { CHANNELS } from "./lib/journeys/channels.ts";
import { FILES } from "./lib/journeys/files.ts";
import { TALK } from "./lib/journeys/talk.ts";
import { SECURITY } from "./lib/journeys/security.ts";
import { MONEY } from "./lib/journeys/money.ts";

const ALL: Journey[] = [
  ...APPS,
  ...MAIL,
  ...CALENDAR,
  ...ORDERS,
  ...PAY,
  ...CHANNELS,
  ...FILES,
  ...TALK,
  ...SECURITY,
  ...MONEY,
];

const check = process.argv.includes("--check");

const report = await runAll(ALL, { check });

console.log("");
console.log("──────────────────────────────────────────────");
console.log(
  `маршрутов: ${report.journeys} · шагов пройдено: ${report.steps} · групп: ${report.groups}/${GROUPS.length}`,
);

if (report.gaps.length > 0) {
  console.log("");
  console.log(`известные дыры (${report.gaps.length}) — суть не красит, чинит владелец:`);
  for (const gap of report.gaps) {
    console.log(`  • ${gap.journey.name}`);
    console.log(`    ${gap.journey.knownGap}`);
  }
}

if (report.healed.length > 0) {
  console.log("");
  console.log(`дыры, которые закрылись (${report.healed.length}) — снимите пометку knownGap:`);
  for (const healed of report.healed) {
    console.log(`  • ${healed.journey.name}`);
  }
}

if (report.failures.length > 0) {
  console.log("");
  console.log(`ПРОВАЛЕНО маршрутов: ${report.failures.length}`);
  for (const bad of report.failures) {
    const f = bad.failure!;
    console.log(`  • ${bad.journey.name} — шаг ${f.index}: ${f.it}`);
  }
  process.exit(1);
}

if (report.healed.length > 0) {
  console.log("");
  console.log("всё зелёное, но пометки knownGap устарели — поправьте их.");
  process.exit(2);
}

console.log("всё зелёное.");

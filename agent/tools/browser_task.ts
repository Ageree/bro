import type { ToolContext } from "eve/tools";
import { defineDynamic, defineTool } from "eve/tools";
import { z } from "zod";
import { resolveModeValue } from "@agent/lib/mode";
import { scopeFromPrincipal } from "@agent/lib/principal-scope";
import { telegramConversationIdSchema } from "@agent/lib/telegram-conversation";
import {
  BrowserUseError,
  browserUseConfigured,
  cancelBrowserUseRun,
  createBrowserUseProfile,
  createBrowserUseRun,
  findBrowserUseSessionCdpUrl,
  listBrowserUseRunEvents,
  liveViewUrlFromEvents,
  queueBrowserUseSessionMessage,
  readBrowserUseRunStatus,
  type BrowserUseCreateRunInput,
  type BrowserUseRunStatus,
} from "@agent/lib/browser-use/client";
import {
  typeOneTimeCodeOverCdp,
  type OneTimeCodeEntry,
} from "@agent/lib/browser-use/cdp";
import { resolveBrowserSecretBindings } from "@agent/lib/browser-use/secrets";
import {
  claimBrowserRunCompletion,
  createBrowserRun,
  finishBrowserRunReport,
  readBrowserProfileId,
  readLatestBrowserRunForScope,
  saveBrowserProfileId,
  stopBrowserRunErrand,
  updateBrowserRunProgress,
} from "@db/services/browser-runs";
import {
  moveSpendReservation,
  reserveAutoPayment,
  settleSpendReservation,
} from "@db/services/spending";
import { readWorkspaceTimeZone } from "@db/services/user-profile";
import { localMonthKey } from "@shared/calendar/local-period";
import {
  type AutoPaymentDecision,
  formatRub,
  normalizeCategory,
  normalizeMerchant,
  spendLimitCurrency,
} from "@shared/spending/limit";
import type { AccessScope } from "@shared/identity/access-scope";
import { browserRunFacts } from "@agent/lib/browser-use/facts";
import {
  browserRunFinalScreenshotStem,
  browserRunImagePrefix,
} from "@agent/lib/browser-use/images";
import { maximumDeliveredImageArtifacts } from "@agent/lib/image-artifact/delivery";
import { env } from "@shared/environment";
import { browserRunNeeds } from "@agent/lib/browser-use/outcome";
import { customProxy } from "@agent/lib/browser-use/proxy";
import { mentionsRecurringCharge } from "@agent/lib/browser-use/spend";
import { browserRunQuotaGate } from "@agent/lib/billing/quota";

const inputSchema = z.object({
  action: z.enum(["start", "continue", "cancel", "status"]),
  allowPayment: z
    .boolean()
    .optional()
    .describe(
      "True when the user approved paying on this errand in this conversation, or together with withinSpendLimit when the payment may fit the standing spend limit the user set. Binds the saved card to the site and its payment processors — a card guarantee that charges nothing today binds it all the same, so it needs one of the two as well."
    ),
  withinSpendLimit: z
    .object({
      category: z
        .string()
        .max(60)
        .optional()
        .describe(
          "One lower-case word for what the payment is for, as the user would name it: «еда», «такси», «кино»."
        ),
      currency: z
        .string()
        .length(3)
        .describe(
          "ISO code of the currency the checkout shows its total in, as seen on the page. Only RUB can fit the limit."
        ),
      feeRub: z
        .number()
        .nonnegative()
        .default(0)
        .describe(
          "Any non-refundable fee, deposit, cancellation or no-show penalty that can be charged on top of totalRub. 0 only when cancelling is free."
        ),
      recurring: z
        .boolean()
        .default(false)
        .describe(
          "True for a subscription, an auto-renewal or any other repeating charge. These are never paid without the user."
        ),
      totalRub: z
        .number()
        .nonnegative()
        .describe(
          "What the checkout charges now. 0 for a card guarantee that charges nothing today."
        ),
    })
    .optional()
    .describe(
      "Set together with allowPayment: true when the user did not approve this payment in the conversation but it may fit the standing spend limit they set. The tool checks it against the limit and the month's spending, reserves it, and tells the run not to pay a kopeck more; when there is no limit or it does not fit, nothing starts and you ask the user."
    ),
  collectImages: z
    .boolean()
    .optional()
    .describe(
      "True when the user asked for photos or pictures of what the errand finds. The run then saves pictures of the items next to the screenshot it always takes, and they come back with the outcome as artifacts to attach."
    ),
  runId: z
    .string()
    .min(1)
    .optional()
    .describe("The run id returned by start. Required for every other action."),
  site: z
    .string()
    .optional()
    .describe(
      "The website origin the errand starts on, such as https://www.example.com — one that serves the person's country and address. Saved credentials are bound to this origin only; name fallback sites in the task text."
    ),
  task: z
    .string()
    .min(1)
    .max(8_000)
    .optional()
    .describe(
      "For start, the errand in the user's own language: the goal, the hard constraints including the user's own words for what they want (a hotel, not a hostel), the saved preferences that bear on it, and two or three fallback sites to try if the first cannot do it. For continue, the answer, code, or changed constraint to pass into the running errand."
    ),
});

const liveViewPollMs = 1_000;
const liveViewPollAttempts = 8;

/**
 * The contract every run ends with. The labels are fixed so the outcome parses
 * the same way whatever language the errand was written in; the values are not.
 */
function outcomeContract() {
  return [
    "Before the labelled footer, write a complete useful report with every material fact the errand requested for each option. The footer is routing metadata and never replaces the report.",
    "Finish your final answer with these labelled lines, written in the language of the errand above:",
    "RESULT: what was actually accomplished, or why it stopped",
    "ORDER: the order, booking, or reference number, or none",
    "TOTAL: the amount charged or shown, or none",
    `NEEDS: exactly one of ${browserRunNeeds.join(", ")}`,
    "DETAILS: the one thing a person must supply or decide, or none",
    'LINKS: a JSON array of {"title":"human-readable option name","url":"https://..."} objects, or []',
    "For every concrete option you recommend or report — product, article, hotel, ticket, restaurant, listing, or anything similar — include its actual observed destination URL in LINKS. Open the option's detail page or extract its actual anchor href from the page. Never guess or construct an ID or URL, and never substitute a live-view URL or a generic search, results, or category URL for an option link.",
  ].join("\n");
}

/**
 * The check is the run's to solve, straight away. Browser Use also runs its
 * own solver in the background, and clicking into it can cost that solve a
 * restart, but a minute spent waiting on every check costs the errand more:
 * the person is waiting on a shop, not on a challenge.
 */
function captchaLine() {
  return [
    "Getting past a CAPTCHA or anti-bot check is part of this errand, not a reason to end it: solve it yourself, right away, and stay on it until the page lets you through — drag the slider, tick «I am not a robot», hold the button, pick the tiles, read out the characters. The browser you are in also solves supported challenges on its own, so a check that is already resolving needs a moment rather than a fight.",
    "Work it at a human pace. If an attempt does not take, try it again, and again after that; a check that comes back on the next page is the same job, not a verdict.",
    "This is never the person's job: they cannot see your screen and will not be asked to do it for you.",
    "Stop with NEEDS: captcha only once the page still blocks you after all of that, and put in DETAILS what it shows.",
  ].join(" ");
}

/**
 * The pictures the run leaves behind, in the one folder of its workspace the
 * completion path reads. The page that shows the outcome is always saved: a
 * confirmation, a basket, a search result is often easier to show than to
 * retell. Pictures of the items only when the person wanted to see them —
 * every extra file is a download at settlement.
 */
function imagesContract(collectImages: boolean) {
  const final = `${browserRunImagePrefix}${browserRunFinalScreenshotStem}.png`;
  return [
    `Before your final answer, save a screenshot of the page that shows the outcome — the viewport as a person would see it — as the file ${final} in your workspace.`,
    collectImages
      ? `The person wants to see the items: also save up to ${String(maximumDeliveredImageArtifacts - 1)} pictures of what you found, one file per item under ${browserRunImagePrefix}, named after the item in lowercase Latin letters and dashes (for example ${browserRunImagePrefix}xiaomi-band-9.jpg) — the item's own large photo, not a thumbnail. Save nothing else under ${browserRunImagePrefix}.`
      : `Save nothing else under ${browserRunImagePrefix}.`,
  ].join(" ");
}

/**
 * Where the person lives decides which sites can do the errand at all: a
 * global shop that will not ship to the country is a dead end the run only
 * discovers at checkout. An errand about somewhere else — a trip, a hotel, a
 * rental in another city — names that place itself, and it wins.
 */
function homeLine(home: string | undefined) {
  if (home === undefined) return undefined;
  return [
    `The person lives in ${home} (from their profile). Unless the errand names another place, deliveries, pickups, prices and availability are for there.`,
    "Before you commit to a site, check that it sells, ships or serves there. A site that refuses the country or the address is the wrong site, not the end of the errand: move to one that serves the place, preferring the local marketplaces and chains people there actually use. If the brand or shop the errand names does not operate there, find the same item from a local seller and say so in the report.",
    "When the errand is about another place, that place wins, and this only tells you the person's country and currency.",
  ].join(" ");
}

/** Searching past this is how an errand spent 45 minutes checking three hotels. */
const searchBudgetMinutes = 15;

/**
 * How to search when the first try comes up empty. The coordinator names the
 * fallback sites in the errand; this is what makes the run use them, and keeps
 * the words the person chose from being traded for whatever the site has.
 */
function searchLine() {
  return [
    "Honour the exact kind of thing the errand asks for: a hotel is not a hostel, a dorm bed or a room in a flat; a direct flight has no stops; «free cancellation» means only such rates. Leave out options of the wrong kind rather than filling the list with them, and say so if too few of the right kind were left.",
    "When the site you are on cannot do the errand — it does not serve the country or the address, it finds nothing, everything is sold out or over budget — do not stop there. Move on to the fallback sites the errand names, or to another well-known site that serves the same place, and widen sensibly before giving up: a neighbouring area, a nearby date, a close alternative. Say in the report what you widened and which sites you tried.",
    "Saved sign-ins exist only for the errand's own site. On a fallback site go on as a guest, and when it will not let you without an account, skip it for the next one rather than stopping with NEEDS: password.",
  ].join(" ");
}

/**
 * The line between staging and committing is money, not the button: the
 * person wants a finished result, so anything free and freely undone is the
 * run's to complete, and anything that charges or binds them to a charge
 * waits for their word — a pay-at-the-property booking with a cancellation
 * fee is a commitment even though nothing is taken today.
 */
function paymentLine(allowPayment: boolean) {
  if (allowPayment) return undefined;
  return [
    "Nothing has been approved to pay for or to commit money to on this errand.",
    "Finish on your own what costs nothing and can be undone for free: a reservation with free cancellation (a table, an appointment, a slot), a registration for a free event, a basket with the delivery details filled in.",
    "Anything that charges or commits money stops on the page with its final button, unpressed: any charge or prepayment, binding a card, pay on delivery, pay at the property, a non-refundable rate, a cancellation fee. Stage it up to that last step, then end with NEEDS: payment and the TOTAL the page shows.",
  ].join(" ");
}

/**
 * A request, not a cap: nothing stops the run at the mark. It asks for the
 * best partial result instead of the forty-five minutes one search once took.
 * Finishing a purchase past it is only right once paying was approved.
 */
function budgetLine(allowPayment: boolean) {
  return [
    `Spend about ${String(searchBudgetMinutes)} minutes searching and comparing, not more, and do not spend them retrying one site. When that time is up, stop and report the best options found so far, saying plainly which parts are partial and what you did not get to check.`,
    allowPayment
      ? "The budget is for searching: once you are completing the order or the booking the errand asked for, finish it rather than abandoning it at the mark."
      : undefined,
  ]
    .filter((line) => line !== undefined)
    .join(" ");
}

function credentialsLine(aliases: readonly string[]) {
  return aliases.length === 0
    ? "No stored credentials are available for this run. If the site asks you to sign in, stop with NEEDS: password instead of guessing one."
    : `Credentials are attached as secrets: focus the field and ask for the secret by name — ${aliases.join(", ")}. The server types the values; you never see them.`;
}

export function composeBrowserTask(options: {
  readonly aliases: readonly string[];
  readonly allowPayment: boolean;
  readonly collectImages: boolean;
  readonly errand: string;
  readonly facts: string | undefined;
  readonly home: string | undefined;
  readonly site: string | undefined;
}) {
  return [
    options.site
      ? `${options.errand}\n\nSite: ${options.site}`
      : options.errand,
    homeLine(options.home),
    searchLine(),
    paymentLine(options.allowPayment),
    budgetLine(options.allowPayment),
    options.facts,
    credentialsLine(options.aliases),
    captchaLine(),
    imagesContract(options.collectImages),
    outcomeContract(),
  ]
    .filter((part) => part !== undefined)
    .join("\n\n");
}

/**
 * A follow-up run in the browser the errand already lives in. The person's own
 * message leads, because it is the instruction; everything after it only says
 * where that instruction lands. The tab, the cookies and the agent's memory of
 * the errand are still there, so telling it to start over would undo the
 * sign-in the person is following up about. Only a follow-up that goes on
 * searching gets the time budget: a code or a confirmation has nothing to
 * search for, and a budget there only invites the run to wander off.
 */
export function composeBrowserContinuation(options: {
  readonly aliases: readonly string[];
  readonly allowPayment: boolean;
  readonly collectImages: boolean;
  readonly errand: string;
  readonly facts: string | undefined;
  readonly message: string;
  readonly searching: boolean;
  readonly site: string | undefined;
}) {
  return [
    options.message,
    [
      `This continues the errand «${options.errand}» in this same browser session. Keep the tab that is open and the account already signed in: do not start over and do not navigate again unless the page is gone.`,
      options.site ? `Site: ${options.site}` : undefined,
    ]
      .filter((line) => line !== undefined)
      .join("\n"),
    paymentLine(options.allowPayment),
    options.searching ? budgetLine(options.allowPayment) : undefined,
    options.facts,
    credentialsLine(options.aliases),
    captchaLine(),
    imagesContract(options.collectImages),
    outcomeContract(),
  ]
    .filter((part) => part !== undefined)
    .join("\n\n");
}

/**
 * The one-time code in a follow-up message, when the message is plainly just
 * that and nothing else.
 *
 * Deliberately narrow. Typing into the page is a shortcut the cloud agent does
 * not need, so it is only worth taking when there is no doubt about what the
 * person sent: bare digits, optionally introduced by the word for a code and
 * broken up the way people copy them out of a text message. Anything else —
 * an address, a correction, a sentence with a number in it — goes to the agent,
 * which is what reads instructions for a living.
 */
export function oneTimeCodeFromMessage(message: string) {
  const text = message.trim().toLowerCase();
  const labelled = /^(?:код|code|otp|sms|смс|пароль из смс)\s*[:—-]?\s*/u;
  const labelMatch = labelled.exec(text);
  const rest = labelMatch ? text.slice(labelMatch[0].length) : text;
  if (!/^\d[\d\s.-]*$/u.test(rest)) return undefined;
  const digits = rest.replaceAll(/\D/gu, "");
  if (digits.length < 4 || digits.length > 8) return undefined;
  // A bare four-digit year is how people answer a question about a date, and a
  // long run of digits is a phone number or an order number, not a code.
  if (!labelMatch && /^(?:19|20)\d{2}$/u.test(digits)) return undefined;
  return digits;
}

/**
 * What the cloud agent is told about a code that is already in the page. It
 * still gets the person's message — it has an errand to finish either way —
 * but retyping a code that is in the field is how a correct code becomes a
 * wrong one.
 */
export function codeEntryNote(entry: OneTimeCodeEntry | undefined) {
  // A partial entry only put the first character somewhere, so as far as the
  // agent is concerned nothing was typed at all.
  if (!entry?.typed || entry.partial) return undefined;
  return entry.submitted
    ? "The one-time code above has already been typed into the page and confirmed. Do not type it again: read what the page shows now and carry on with the errand."
    : "The one-time code above has already been typed into the field on the page, but nothing was submitted. Do not type it again: confirm it if the page is waiting for that, then carry on with the errand.";
}

function withCodeEntry(message: string, entry: OneTimeCodeEntry | undefined) {
  const note = codeEntryNote(entry);
  return note === undefined ? message : `${message}\n\n${note}`;
}

/**
 * Best effort, and never fatal: when the browser cannot be found or the field
 * cannot be identified with confidence, the code travels on to the cloud agent
 * exactly as it did before any of this existed.
 */
async function typeCodeIntoRunBrowser(sessionId: string, message: string) {
  const code = oneTimeCodeFromMessage(message);
  if (code === undefined) return undefined;
  try {
    const cdpUrl = await findBrowserUseSessionCdpUrl(sessionId);
    if (cdpUrl === undefined) return undefined;
    const entry = await typeOneTimeCodeOverCdp(cdpUrl, code);
    console.info("[browser-use] one-time code entry", {
      // Never the code itself, and never the challenge URL: it carries tokens.
      inFrame: entry.inFrame,
      searched: entry.searched,
      sessionId,
      submitted: entry.submitted,
      typed: entry.typed,
    });
    return entry;
  } catch (error) {
    console.warn("[browser-use] the code could not be typed into the page", {
      cause: error,
      sessionId,
    });
    return undefined;
  }
}

function conversationTarget(context: ToolContext) {
  const auth = context.session.auth.current ?? context.session.auth.initiator;
  if (auth?.principalType !== "user") {
    throw new Error("An authenticated user is required to run a browser task.");
  }
  const conversationChannel = z
    .enum(["eve", "photon", "telegram"])
    .parse(auth.attributes.conversationChannel);
  const conversationId =
    conversationChannel === "eve"
      ? context.session.id
      : conversationChannel === "photon"
        ? z
            .string()
            .startsWith("imessage:")
            .parse(auth.attributes.conversationId)
        : telegramConversationIdSchema.parse(auth.attributes.conversationId);
  const replyAnchorMessageId = z
    .string()
    .min(1)
    .safeParse(
      conversationChannel === "telegram"
        ? auth.attributes.telegramMessageId
        : auth.attributes.photonMessageId
    );
  return {
    conversation: {
      conversationChannel,
      conversationId,
      replyAnchorMessageId: replyAnchorMessageId.data ?? null,
      rootSessionId: context.session.id,
    },
    scope: scopeFromPrincipal(auth),
  };
}

async function workspaceProfileId(scope: {
  readonly userId: string;
  readonly workspaceId: string;
}) {
  const existing = await readBrowserProfileId(scope);
  if (existing) return existing;
  const profile = await createBrowserUseProfile("Bro workspace", scope.userId);
  return saveBrowserProfileId(scope, profile.id);
}

/**
 * What the finished run stopped on. The outcome column holds the
 * coordinator's own summary, whose `Needs:` line is the labelled value the
 * run reported.
 */
function endedNeeding(outcome: string | null | undefined) {
  return /^needs:[ \t]*([a-z0-9_]+)[ \t]*$/imu
    .exec(outcome ?? "")?.[1]
    ?.toLowerCase();
}

/** Stops a follow-up only confirms or unlocks: there is nothing to search. */
const confirmationNeeds = new Set<string>([
  "3ds",
  "email_code",
  "password",
  "payment",
  "push",
  "sms_code",
]);

/**
 * Whether a follow-up goes on searching. A short reply that carries a code —
 * «Код из смс 992130» as much as a bare «992130» — or an answer to a run that
 * stopped on a code, a sign-in or a payment, is a confirmation; anything else
 * — a changed constraint, «поищи ещё», a run that stopped on a question or a
 * wall — is more searching. Looser than `oneTimeCodeFromMessage` on purpose:
 * a wrong guess here only costs one line of the prompt, not a typed field.
 */
function followUpSearches(message: string, outcome: string | null) {
  const text = message.trim();
  if (text.length <= 40 && /(?:^|\D)\d{4,8}(?:\D|$)/u.test(text)) return false;
  return !confirmationNeeds.has(endedNeeding(outcome) ?? "");
}

type SpendLimitInput = NonNullable<
  z.infer<typeof inputSchema>["withinSpendLimit"]
>;

/**
 * What the run is told about paying on the person's standing permission. The
 * page is the only place the real total shows, so the run is the one that has
 * to hold the line: anything above what was approved stops before the pay
 * button, whatever the coordinator expected.
 */
export function spendCapLine(
  payment: SpendLimitInput,
  decision: Extract<AutoPaymentDecision, { allowed: true }>
) {
  const stop =
    "stop before confirming with NEEDS: payment, and put the real total and every fee in TOTAL and DETAILS";
  // A dollar figure under the rouble cap is not under it: the run is the one
  // that sees which currency the page charges in.
  const roubles = `The permission is in Russian roubles only: if the checkout shows its total in any other currency, or cannot say which, do not pay — ${stop}.`;
  const recurring =
    "A subscription, a trial that turns into one, auto-renewal or any other repeating charge is never covered.";
  if (decision.exposureRub === 0) {
    return `The saved card may be attached only as a guarantee: nothing may be charged now, and cancelling must be free. If the checkout wants to charge anything now or holds a non-refundable fee, deposit or no-show penalty, do not confirm — ${stop}. ${recurring} ${roubles}`;
  }
  const fee =
    payment.feeRub > 0
      ? ` (${formatRub(payment.totalRub)} now plus up to ${formatRub(payment.feeRub)} in non-refundable fees)`
      : "";
  return `Payment is pre-approved up to ${formatRub(decision.exposureRub)} in total${fee}, including every fee, deposit and cancellation penalty. Before you confirm, check the final amount on the page. If it is higher, if a fee appears that was not counted, or if it is a subscription or a repeating charge, do not pay — ${stop}. ${recurring} ${roubles} A paid order still ends with ORDER and TOTAL filled in as usual; a payment that went through without an order number still reports its TOTAL.`;
}

function spendRefusalNote(
  decision: Extract<AutoPaymentDecision, { allowed: false }>
) {
  const why = {
    currency: `the checkout is not in ${spendLimitCurrency}, the limit's currency`,
    excluded:
      "the user excluded this merchant or category from paying without asking",
    no_limit: "the user has not set a standing spend limit",
    no_rule: "no spend limit the user set covers this merchant or category",
    over_limit: `it is more than is left under the limit this month (${formatRub(decision.remainingRub ?? 0)})`,
    recurring:
      "subscriptions and repeating charges are never paid without the user",
  }[decision.reason];
  return `Nothing was started: the payment does not fit the standing spend limit — ${why}. Ask the user once, in one short sentence naming the site, what you are buying and the total, or start the errand without allowPayment to take it up to the payment step first.`;
}

async function spendPeriodKey(scope: AccessScope) {
  return localMonthKey(new Date(), await readWorkspaceTimeZone(scope));
}

/**
 * Check a payment against the standing limit and hold its share of the month
 * under a placeholder until the run exists. The placeholder is renamed to the
 * run id once Browser Use hands one back, or released if the run never starts.
 * The errand's words and what the run last reported are read for a
 * subscription as well: the coordinator's `recurring` flag is not the only
 * thing standing between the limit and a repeating charge.
 */
async function reserveSpendForRun(
  scope: AccessScope,
  payment: SpendLimitInput,
  errand: {
    readonly replacingRunId?: string;
    readonly site: string | undefined;
    readonly texts: readonly (string | null | undefined)[];
  }
) {
  const placeholder = `pending:${crypto.randomUUID()}`;
  const decision = await reserveAutoPayment(scope, {
    browserRunId: placeholder,
    periodKey: await spendPeriodKey(scope),
    replacingRunId: errand.replacingRunId,
    request: {
      amount: payment.totalRub,
      category: normalizeCategory(payment.category),
      currency: payment.currency,
      fee: payment.feeRub,
      merchant: normalizeMerchant(errand.site),
      recurring: payment.recurring || mentionsRecurringCharge(...errand.texts),
    },
  });
  return { decision, placeholder };
}

/**
 * Run the steps between a fresh reservation and the run it pays for. When any
 * of them throws, the reservation is released: money is only held for a run
 * that exists.
 */
async function releasedOnFailure<T>(
  placeholder: string | undefined,
  work: () => Promise<T>
) {
  try {
    return await work();
  } catch (error) {
    if (placeholder) await releaseReservation(placeholder);
    throw error;
  }
}

async function releaseReservation(browserRunId: string) {
  await settleSpendReservation(browserRunId, { charged: false });
}

/**
 * Recording a run that already exists in the cloud failed: nothing here would
 * ever settle it, so it is stopped and whatever it held is given back.
 */
async function recordStartedRun<T>(runId: string, record: () => Promise<T>) {
  try {
    await record();
  } catch (error) {
    try {
      await cancelBrowserUseRun(runId);
    } catch (cancelError) {
      console.warn("[browser-use] the unrecorded run could not be cancelled", {
        cause: cancelError,
        runId,
      });
    }
    await releaseReservation(runId);
    throw error;
  }
}

const terminalRunStatuses = new Set<BrowserUseRunStatus>([
  "cancelled",
  "completed",
  "failed",
]);

/**
 * Whether the tracked run can still accept a queued message. Browser Use
 * drains a message queued onto an idle session immediately — as a new run the
 * caller never learns the id of — so a run that has already finished must be
 * continued with a run of its own instead.
 */
async function trackedRunIsLive(runId: string, completedAt: Date | null) {
  if (completedAt) return false;
  try {
    return !terminalRunStatuses.has(await readBrowserUseRunStatus(runId));
  } catch (error) {
    console.warn("[browser-use] run status could not be read", {
      cause: error,
      runId,
    });
    return false;
  }
}

/**
 * The follow-up run inside the errand's own session. A busy session answers
 * 409 and the caller falls back to the queue; a session that no longer exists
 * answers 404, and the run is made again without one so it opens a fresh
 * browser on the same profile, where the signed-in cookies live.
 */
async function createFollowUpRun(input: BrowserUseCreateRunInput) {
  const asked = input.sessionId !== undefined;
  try {
    return { reusedSession: asked, run: await createBrowserUseRun(input) };
  } catch (error) {
    if (!(error instanceof BrowserUseError)) throw error;
    if (error.status === 409) return { reusedSession: asked, run: undefined };
    if (error.status !== 400 && error.status !== 404) throw error;
    return {
      reusedSession: false,
      run: await createBrowserUseRun({ ...input, sessionId: undefined }),
    };
  }
}

// The live browser takes a few seconds to come up, and its takeover URL only
// exists once it has. Recursion rather than a loop keeps each attempt one
// awaited step instead of a sequential await inside an iteration.
async function waitForLiveViewUrl(
  runId: string,
  attemptsLeft = liveViewPollAttempts
): Promise<string | undefined> {
  if (attemptsLeft <= 0) return undefined;
  await new Promise((resolve) => setTimeout(resolve, liveViewPollMs));
  try {
    const page = await listBrowserUseRunEvents(runId);
    const liveViewUrl = liveViewUrlFromEvents(page.events);
    if (liveViewUrl) return liveViewUrl;
  } catch (error) {
    console.warn("[browser-use] live view lookup failed", {
      cause: error,
      runId,
    });
    return undefined;
  }
  return waitForLiveViewUrl(runId, attemptsLeft - 1);
}

export const browserTask = defineTool({
  description:
    "Run one errand on a website through a hosted cloud browser that can sign in, fill forms, and complete a checkout. Use it when the user wants something done on a site; use web_search and web_fetch instead for reading public pages. Start exactly one run per errand and pass the site's origin so saved credentials can be bound to it; pick a site that serves the user's country and address, preferring local marketplaces over a global brand site that does not ship there. Write the errand short: the cloud browser is itself an agent, so give it the goal, the hard constraints in the user's own words, the saved preferences that bear on it, two or three fallback sites, and what to report back — not a click-by-click script. The run is told the user's city and country from Personal Info and asked to report its best partial results after about 15 minutes of searching. Searching, comparing and staging an order or a booking need no card and no allowPayment: start such an errand right away. Without allowPayment the run finishes on its own only what is free and freely cancelled — a reservation with free cancellation, a free registration, a basket — and stops before the final step of anything that charges or commits money (prepayment, binding a card, pay on delivery or at the property, a non-refundable rate, a cancellation fee) with NEEDS: payment and the TOTAL; ask the user in one sentence and continue with allowPayment: true once they agree — or, without asking, with allowPayment: true and withinSpendLimit when the payment may fit the user's standing spend limit: the tool decides, reserves the amount and caps the run; when it answers needs_approval, ask the user once. Every follow-up for that errand — an answer, a code the user typed, a changed constraint — goes through continue with the same runId, never a second start: continue works in the same browser, on the tab and the signed-in account the run already has. When the previous run has already finished, continue starts a follow-up run in that same browser and returns a NEW runId; use that one from then on. Pass allowPayment: true on start or on continue once the user approved paying or attaching a card on this errand in this conversation — «привяжи карту» is approval to bind the saved card, not to buy anything. The person's name, phone, email and addresses from the profile and from the vault are typed into forms automatically, so never ask for a phone number or an address the user said is saved: start the errand and let the run use it. The run signs in with vault credentials the models involved never see, so never ask the user for a password: when none is stored, call request_vault_setup. The run solves CAPTCHAs and anti-bot checks itself as it goes, and they are never the user's to solve: never tell the user you cannot pass one, never ask them to pass it, and never hand them the live view for one. A run the site stops at an anti-bot check is retried in the background by itself — a fresh browser on another address, on the same profile, up to five attempts over about half an hour — and its result reaches you only once the errand is done or the site stayed blocked; status and continue on the old runId follow the errand to its newest run. Give the user the live-view link only when the run is blocked on something only they can do — 3-D Secure, a push approval, a sign-in you cannot complete — and never forward a one-time code back to the user. Pass collectImages: true when the user asked for photos or pictures of what the errand finds; the run always saves a screenshot of the page with the outcome, and with the flag it saves pictures of the items too. Every saved image comes back with the outcome as an artifact id you attach in send_message as ![caption](/artifacts/id) — that is how the person gets the real picture rather than a link. The run continues in the background and its result arrives later as a new message, so do not wait on it.",
  inputSchema,
  async execute(input, context) {
    const { conversation, scope } = conversationTarget(context);

    if (input.action === "start") {
      const errand = z
        .string()
        .min(1, "A start action needs the errand text.")
        .parse(input.task);
      const allowPayment = input.allowPayment === true;
      // A payment on the standing limit is decided first: a refusal must not
      // count against the month's errands or provision anything.
      const spend =
        allowPayment && input.withinSpendLimit
          ? await reserveSpendForRun(scope, input.withinSpendLimit, {
              site: input.site,
              texts: [errand],
            })
          : undefined;
      if (spend && !spend.decision.allowed) {
        return {
          note: spendRefusalNote(spend.decision),
          status: "needs_approval",
        };
      }
      const placeholder = spend?.decision.allowed
        ? spend.placeholder
        : undefined;
      const started = await releasedOnFailure(placeholder, async () => {
        // The monthly ceiling is checked before anything is provisioned: a
        // refused errand must not cost a remote profile or a bound secret.
        const quota = await browserRunQuotaGate(scope);
        if (!quota.allowed) {
          return { kind: "quota_exhausted" as const, note: quota.note };
        }
        const [profileId, secrets, facts] = await Promise.all([
          workspaceProfileId(scope),
          resolveBrowserSecretBindings(scope, {
            allowPayment,
            site: input.site,
          }),
          browserRunFacts(scope),
        ]);
        const task = composeBrowserTask({
          aliases: secrets.aliases,
          allowPayment,
          collectImages: input.collectImages === true,
          errand:
            spend?.decision.allowed && input.withinSpendLimit
              ? `${errand}\n\n${spendCapLine(input.withinSpendLimit, spend.decision)}`
              : errand,
          facts: facts.details,
          home: facts.home,
          site: input.site,
        });
        const run = await createBrowserUseRun({
          customProxy: customProxy(),
          maxCostUsd: env.BROWSER_USE_MAX_COST_USD,
          model: env.BROWSER_USE_MODEL,
          profileId,
          proxyCountryCode: env.BROWSER_USE_PROXY_COUNTRY,
          secretBindings: secrets.bindings,
          task,
        });
        return { kind: "started" as const, profileId, run, secrets };
      });
      if (started.kind === "quota_exhausted") {
        if (placeholder) await releaseReservation(placeholder);
        return { note: started.note, status: "quota_exhausted" };
      }
      const { profileId, run, secrets } = started;
      if (placeholder) await moveSpendReservation(placeholder, run.id);
      await recordStartedRun(run.id, () =>
        createBrowserRun(scope, {
          ...conversation,
          id: run.id,
          paymentAllowed: allowPayment,
          profileId,
          sessionId: run.sessionId,
          site: input.site ?? null,
          status: "running",
          task: errand,
        })
      );
      const liveViewUrl = await waitForLiveViewUrl(run.id);
      if (liveViewUrl) {
        await updateBrowserRunProgress(run.id, { liveViewUrl });
      }
      return {
        boundSecrets: secrets.aliases,
        liveViewUrl,
        note: [
          "The run continues in the background. Its outcome arrives as a new message; do not poll for it.",
          spend?.decision.allowed
            ? `The payment fits the standing spend limit the user set (${formatRub(spend.decision.exposureRub)} reserved, ${formatRub(spend.decision.remainingAfterRub)} left this month), so do not ask them about it: report the receipt once the outcome arrives.`
            : undefined,
        ]
          .filter((line) => line !== undefined)
          .join(" "),
        runId: run.id,
        status: "running",
      };
    }

    const requestedRunId = z
      .string()
      .min(1, "This action needs the runId returned by start.")
      .parse(input.runId);
    // A background retry may have taken the errand over since the
    // conversation last saw it; the newest run of the chain is the errand.
    const row = await readLatestBrowserRunForScope(scope, requestedRunId);
    if (!row)
      throw new Error("That browser run is not part of this workspace.");
    const runId = row.id;

    if (input.action === "continue") {
      const message = z
        .string()
        .min(1, "A continue action needs the message to pass into the run.")
        .parse(input.task);
      const allowPayment = input.allowPayment === true;
      // The errand's origin is fixed when it starts: the browser is already on
      // that site, signed in, and the run's secrets are bound to it. A site the
      // model passes on a follow-up can only be a mix-up with another errand in
      // the same conversation — one that would point the run at the wrong shop
      // and attach another site's credentials to it — so the row wins.
      const site = row.site ?? input.site ?? undefined;
      // A fresh decision on the standing limit is made with whatever this
      // errand already holds still counted, and replaces it only once a run
      // carries the new one: a refusal leaves the old reservation in place.
      const spend =
        allowPayment && input.withinSpendLimit
          ? await reserveSpendForRun(scope, input.withinSpendLimit, {
              replacingRunId: runId,
              site,
              texts: [row.task, row.outcome, message],
            })
          : undefined;
      if (spend && !spend.decision.allowed) {
        return {
          note: spendRefusalNote(spend.decision),
          runId,
          status: "needs_approval",
        };
      }
      const placeholder = spend?.decision.allowed
        ? spend.placeholder
        : undefined;
      const instruction =
        spend?.decision.allowed && input.withinSpendLimit
          ? `${message}\n\n${spendCapLine(input.withinSpendLimit, spend.decision)}`
          : message;
      const continued = await releasedOnFailure(placeholder, async () => {
        // Both are round trips to the cloud and neither needs the other's answer.
        // A one-time code waiting its turn is a code closer to expiring, and the
        // entry is worth attempting whether or not a run is still on the page:
        // the browser outlives its run, and the field is where the code belongs.
        const [live, codeEntry] = await Promise.all([
          trackedRunIsLive(runId, row.completedAt),
          typeCodeIntoRunBrowser(row.sessionId, message),
        ]);

        // A live run already carries the secrets it was created with, so a plain
        // follow-up is just a message on its queue. Bindings exist per run only:
        // a card the person has only now approved needs a run of its own.
        if (live && !allowPayment) {
          await queueBrowserUseSessionMessage(
            row.sessionId,
            withCodeEntry(message, codeEntry)
          );
          return {
            kind: "replied" as const,
            reply: {
              note:
                codeEntryNote(codeEntry) === undefined
                  ? "The message was queued into the running errand. Its outcome still arrives as a new message."
                  : "The code went straight into the page, and the message was queued into the running errand as well. Its outcome still arrives as a new message.",
              runId,
              status: row.status,
            },
          };
        }
        if (live) {
          try {
            await cancelBrowserUseRun(runId);
          } catch (error) {
            console.warn(
              "[browser-use] the replaced run could not be cancelled",
              {
                cause: error,
                runId,
              }
            );
          }
          // Claiming the completion here is what keeps the webhook and the
          // poller from reporting the replaced run as an outcome of its own.
          await claimBrowserRunCompletion(runId, {
            outcome: "Заменён продолжением с привязанной картой",
            status: "stopped",
          });
        } else {
          // The person is steering a settled errand now: a background retry
          // waiting for it, or being started, would only race this follow-up.
          await stopBrowserRunErrand(runId);
        }

        // No quota gate: `browserRunQuotaGate` counts as it reads, and a
        // continuation is the same errand the month was already charged for.
        const [secrets, facts] = await Promise.all([
          resolveBrowserSecretBindings(scope, { allowPayment, site }),
          browserRunFacts(scope),
        ]);
        const profileId = row.profileId ?? (await workspaceProfileId(scope));
        // A browser that lost to an anti-bot wall keeps losing: the shop has
        // already judged that address and that browser, and a follow-up queued
        // into it meets the same verdict however well it is written. The profile
        // carries the sign-in, so dropping the session keeps the account and
        // gets a fresh browser on a fresh address.
        const followUp = await createFollowUpRun({
          customProxy: customProxy(),
          maxCostUsd: env.BROWSER_USE_MAX_COST_USD,
          model: env.BROWSER_USE_MODEL,
          profileId,
          proxyCountryCode: env.BROWSER_USE_PROXY_COUNTRY,
          secretBindings: secrets.bindings,
          sessionId:
            endedNeeding(row.outcome) === "captcha" ? undefined : row.sessionId,
          task: composeBrowserContinuation({
            aliases: secrets.aliases,
            allowPayment,
            collectImages: input.collectImages === true,
            errand: row.task,
            facts: facts.details,
            message: withCodeEntry(instruction, codeEntry),
            searching: followUpSearches(message, row.outcome),
            site,
          }),
        });
        if (!followUp.run) {
          // Bindings exist per run, so a busy session takes the message but
          // not the card: whatever was reserved for it is not going to be paid.
          await queueBrowserUseSessionMessage(
            row.sessionId,
            withCodeEntry(instruction, codeEntry)
          );
          return {
            kind: "replied" as const,
            reply: {
              note: "The browser session was busy with another run, so the message was queued onto it instead. Keep using this run id; the outcome arrives as a new message.",
              runId,
              status: row.status,
            },
          };
        }
        return {
          followUp: followUp.run,
          kind: "continued" as const,
          profileId,
          reusedSession: followUp.reusedSession,
          secrets,
        };
      });
      if (continued.kind === "replied") {
        if (placeholder) await releaseReservation(placeholder);
        return continued.reply;
      }
      const { followUp, profileId, reusedSession, secrets } = continued;
      if (placeholder) {
        // The decision already released what this errand held before.
        await moveSpendReservation(placeholder, followUp.id);
      } else if (allowPayment) {
        // The person approved this payment themselves: it is theirs, not the
        // standing limit's, so an earlier reservation no longer applies.
        await releaseReservation(runId);
      } else {
        // Whatever this errand still had reserved travels with it: a code
        // that completes a payment on the limit is still that payment.
        await moveSpendReservation(runId, followUp.id);
      }
      await recordStartedRun(followUp.id, () =>
        createBrowserRun(scope, {
          ...conversation,
          id: followUp.id,
          liveViewUrl: reusedSession ? row.liveViewUrl : null,
          paymentAllowed: allowPayment,
          profileId,
          sessionId: followUp.sessionId,
          site: site ?? null,
          status: "running",
          task: message,
        })
      );
      const inheritedLiveViewUrl = reusedSession ? row.liveViewUrl : null;
      const liveViewUrl =
        inheritedLiveViewUrl ?? (await waitForLiveViewUrl(followUp.id));
      if (liveViewUrl && liveViewUrl !== row.liveViewUrl) {
        await updateBrowserRunProgress(followUp.id, { liveViewUrl });
      }
      return {
        boundSecrets: secrets.aliases,
        liveViewUrl,
        note: [
          `This errand now continues as run ${followUp.id}${reusedSession ? " in the same browser" : ""}. Use that run id from here on: ${runId} is finished and takes no further follow-up.`,
          reusedSession
            ? undefined
            : "The previous browser session was not reused — it was gone, or it had ended against an anti-bot check — so the follow-up opened a fresh browser on the same profile, on a new address; the signed-in cookies came with it.",
          "The outcome arrives as a new message; do not poll for it.",
        ]
          .filter((line) => line !== undefined)
          .join(" "),
        previousRunId: runId,
        runId: followUp.id,
        status: "running",
      };
    }

    if (input.action === "cancel") {
      // A settled run has nothing left to cancel in the cloud; stopping its
      // row is what keeps a background retry from starting for it, including
      // one the poller is starting right now.
      if (!row.completedAt) {
        await cancelBrowserUseRun(runId);
        await claimBrowserRunCompletion(runId, {
          outcome: "The user cancelled this browser run.",
          status: "stopped",
        });
      }
      await stopBrowserRunErrand(runId);
      await releaseReservation(runId);
      return { runId, status: "stopped" };
    }

    const status = row.completedAt
      ? row.status
      : await readBrowserUseRunStatus(runId);
    // A report that never reached the conversation is handed over here, and
    // counts as delivered: the poller must not repeat what this turn says.
    const undelivered = row.report !== null && row.reportDeliveredAt === null;
    if (undelivered) await finishBrowserRunReport(runId);
    return {
      liveViewUrl: row.liveViewUrl ?? undefined,
      note:
        [
          runId === requestedRunId
            ? undefined
            : `The errand was retried in the background after an anti-bot check and now lives in run ${runId}; use that id from here on.`,
          row.retryAt
            ? "The site stopped this attempt at an anti-bot check, and the next attempt starts by itself in a fresh browser shortly. The errand is still in progress: say so without mentioning the check."
            : undefined,
          undelivered
            ? "This outcome never reached the conversation as its own message. Tell the user what happened now."
            : undefined,
        ]
          .filter((line) => line !== undefined)
          .join(" ") || undefined,
      outcome: row.outcome ?? undefined,
      runId,
      status,
    };
  },
});

export default defineDynamic({
  events: {
    "turn.started": (_event, context) =>
      browserUseConfigured()
        ? resolveModeValue(context, {
            interactive: { browser_task: browserTask },
            "scheduled-worker": { browser_task: browserTask },
          })
        : null,
  },
});

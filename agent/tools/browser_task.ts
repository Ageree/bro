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
  readBrowserRunForScope,
  saveBrowserProfileId,
  updateBrowserRunProgress,
} from "@db/services/browser-runs";
import { browserRunFacts } from "@agent/lib/browser-use/facts";
import {
  browserRunFinalScreenshotStem,
  browserRunImagePrefix,
} from "@agent/lib/browser-use/images";
import { maximumDeliveredImageArtifacts } from "@agent/lib/image-artifact/delivery";
import { env } from "@shared/environment";
import { browserRunNeeds } from "@agent/lib/browser-use/outcome";
import { browserRunQuotaGate } from "@agent/lib/billing/quota";

const inputSchema = z.object({
  action: z.enum(["start", "continue", "cancel", "status"]),
  allowPayment: z
    .boolean()
    .optional()
    .describe(
      "Only true when the user approved paying on this errand in this conversation. Binds the saved card to the site and its payment processors."
    ),
  allowSubmit: z
    .boolean()
    .optional()
    .describe(
      "Only true when the user explicitly asked in this conversation for this errand to be done in their name: to book or reserve, sign them up, place an order, or send a request, application, message or contact form (for example «забронируй», «запиши меня», «оставь заявку», «закажи»). A request to find, compare, choose or recommend is not that: leave it unset, and the run stops at the options without typing the user's name, phone, email or address anywhere. Pass it on start and again on every continue of such an errand, or when the user approves a booking or request the run found."
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

/**
 * The deployment's own proxy, when it has one. Browser Use takes it per run and
 * neither stores it nor hands it to a follow-up, so every run this tool starts
 * asks for it again; without a host and a port the hosted pool is used, picked
 * by country.
 */
function customProxy() {
  const host = env.BROWSER_USE_PROXY_HOST;
  const port = env.BROWSER_USE_PROXY_PORT;
  if (host === undefined || port === undefined) return undefined;
  return {
    host,
    password: env.BROWSER_USE_PROXY_PASSWORD,
    port,
    username: env.BROWSER_USE_PROXY_USERNAME,
  };
}

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
 * Acting in the person's name is theirs to ask for, even when it is free: a
 * benchmark run asked only for a dinner recommendation started booking the
 * table, and one about assembling furniture filed a Profi.ru request with the
 * person's phone number. Without `allowSubmit` the run only looks, and it is
 * not given the person's details to type anywhere.
 */
function commitmentLine(allowSubmit: boolean) {
  if (allowSubmit) {
    return [
      "The person asked for this errand to be carried out in their name: you may fill in and submit the booking, order, registration, request or form the errand names, with the known details below.",
      "Submit only what the errand names: no extra sign-ups, newsletters, messages to other people or businesses, or a second booking.",
    ].join(" ");
  }
  return [
    "The person has not approved acting in their name on this errand. Never book or reserve anything (not even with free cancellation), never register, sign up or place an order, and never submit a contact form, request, application, callback or message to a business or a person.",
    "Never type the person's name, phone number, email or address into any site. Search, compare and read only, then report the options with their links: when the errand asks you to find or recommend something, the recommendation is the end of the errand.",
    "If going further would need a booking, a request or the person's details, stop there and end with NEEDS: decision, saying in DETAILS what you would submit and where.",
  ].join(" ");
}

/**
 * The line between staging and paying is money: anything that charges or
 * binds the person to a charge waits for their word — a pay-at-the-property
 * booking with a cancellation fee is a commitment even though nothing is
 * taken today.
 */
function paymentLine(allowPayment: boolean) {
  if (allowPayment) return undefined;
  return [
    "Nothing has been approved to pay for or to commit money to on this errand.",
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
  readonly allowSubmit: boolean;
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
    commitmentLine(options.allowSubmit),
    paymentLine(options.allowPayment),
    budgetLine(options.allowPayment),
    options.allowSubmit ? options.facts : undefined,
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
  readonly allowSubmit: boolean;
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
    commitmentLine(options.allowSubmit),
    paymentLine(options.allowPayment),
    options.searching ? budgetLine(options.allowPayment) : undefined,
    options.allowSubmit ? options.facts : undefined,
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
    "Run one errand on a website through a hosted cloud browser that can sign in, fill forms, and complete a checkout. Use it when the user wants something done on a site; use web_search and web_fetch instead for reading public pages. Start exactly one run per errand and pass the site's origin so saved credentials can be bound to it; pick a site that serves the user's country and address, preferring local marketplaces over a global brand site that does not ship there. Write the errand short: the cloud browser is itself an agent, so give it the goal, the hard constraints in the user's own words, the saved preferences that bear on it, two or three fallback sites, and what to report back — not a click-by-click script. The run is told the user's city and country from Personal Info and asked to report its best partial results after about 15 minutes of searching. Searching and comparing need no card and no approval: start such an errand right away. Doing anything in the user's name — booking or reserving (even free and freely cancelled), signing up, ordering, or sending a request, message or contact form, or typing their name, phone, email or address into a site — needs allowSubmit: true, which you set only when the user explicitly asked for exactly that; a request to find or recommend options ends at the recommendation, so leave it unset and offer the booking as the next step. Without allowPayment the run stops before the final step of anything that charges or commits money (prepayment, binding a card, pay on delivery or at the property, a non-refundable rate, a cancellation fee) with NEEDS: payment and the TOTAL; ask the user in one sentence and continue with allowPayment: true once they agree. Every follow-up for that errand — an answer, a code the user typed, a changed constraint — goes through continue with the same runId, never a second start: continue works in the same browser, on the tab and the signed-in account the run already has. When the previous run has already finished, continue starts a follow-up run in that same browser and returns a NEW runId; use that one from then on. Pass allowPayment: true on start or on continue once the user approved paying or attaching a card on this errand in this conversation — «привяжи карту» is approval to bind the saved card, not to buy anything. With allowSubmit, the person's name, phone, email and addresses from the profile and from the vault are typed into forms automatically, so never ask for a phone number or an address the user said is saved: start the errand and let the run use it. The run signs in with vault credentials the models involved never see, so never ask the user for a password: when none is stored, call request_vault_setup. The run solves CAPTCHAs and anti-bot checks itself as it goes, and they are never the user's to solve: never tell the user you cannot pass one, never ask them to pass it, and never hand them the live view for one. When a run comes back with NEEDS: captcha, continue it on the same runId, tell it to solve the check and finish the errand; the continuation opens a fresh browser on the same profile by itself when the old one is still walled. Give the user the live-view link only when the run is blocked on something only they can do — 3-D Secure, a push approval, a sign-in you cannot complete, or a check the run still could not pass after retrying — and never forward a one-time code back to the user. Pass collectImages: true when the user asked for photos or pictures of what the errand finds; the run always saves a screenshot of the page with the outcome, and with the flag it saves pictures of the items too. Every saved image comes back with the outcome as an artifact id you attach in send_message as ![caption](/artifacts/id) — that is how the person gets the real picture rather than a link. The run continues in the background and its result arrives later as a new message, so do not wait on it.",
  inputSchema,
  async execute(input, context) {
    const { conversation, scope } = conversationTarget(context);

    if (input.action === "start") {
      const errand = z
        .string()
        .min(1, "A start action needs the errand text.")
        .parse(input.task);
      // The monthly ceiling is checked before anything is provisioned: a
      // refused errand must not cost a remote profile or a bound secret.
      const quota = await browserRunQuotaGate(scope);
      if (!quota.allowed) {
        return { note: quota.note, status: "quota_exhausted" };
      }
      const [profileId, secrets, facts] = await Promise.all([
        workspaceProfileId(scope),
        resolveBrowserSecretBindings(scope, {
          allowPayment: input.allowPayment === true,
          site: input.site,
        }),
        browserRunFacts(scope),
      ]);
      const task = composeBrowserTask({
        aliases: secrets.aliases,
        allowPayment: input.allowPayment === true,
        // Paying for an errand is asking for it to be done in one's name.
        allowSubmit: input.allowSubmit === true || input.allowPayment === true,
        collectImages: input.collectImages === true,
        errand,
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
      await createBrowserRun(scope, {
        ...conversation,
        id: run.id,
        profileId,
        sessionId: run.sessionId,
        site: input.site ?? null,
        status: "running",
        task: errand,
      });
      const liveViewUrl = await waitForLiveViewUrl(run.id);
      if (liveViewUrl) {
        await updateBrowserRunProgress(run.id, { liveViewUrl });
      }
      return {
        boundSecrets: secrets.aliases,
        liveViewUrl,
        note: "The run continues in the background. Its outcome arrives as a new message; do not poll for it.",
        runId: run.id,
        status: "running",
      };
    }

    const runId = z
      .string()
      .min(1, "This action needs the runId returned by start.")
      .parse(input.runId);
    const row = await readBrowserRunForScope(scope, runId);
    if (!row)
      throw new Error("That browser run is not part of this workspace.");

    if (input.action === "continue") {
      const message = z
        .string()
        .min(1, "A continue action needs the message to pass into the run.")
        .parse(input.task);
      const allowPayment = input.allowPayment === true;
      const allowSubmit = input.allowSubmit === true || allowPayment;
      // The errand's origin is fixed when it starts: the browser is already on
      // that site, signed in, and the run's secrets are bound to it. A site the
      // model passes on a follow-up can only be a mix-up with another errand in
      // the same conversation — one that would point the run at the wrong shop
      // and attach another site's credentials to it — so the row wins.
      const site = row.site ?? input.site ?? undefined;
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
      // a card the person has only now approved needs a run of its own. A
      // submission approved now rides on the message with the details it may
      // type, which is harmless when the run already had both.
      if (live && !allowPayment) {
        const approval = allowSubmit
          ? (await browserRunFacts(scope)).details
          : undefined;
        await queueBrowserUseSessionMessage(
          row.sessionId,
          [
            withCodeEntry(message, codeEntry),
            allowSubmit ? commitmentLine(true) : undefined,
            approval,
          ]
            .filter((part) => part !== undefined)
            .join("\n\n")
        );
        return {
          note:
            codeEntryNote(codeEntry) === undefined
              ? "The message was queued into the running errand. Its outcome still arrives as a new message."
              : "The code went straight into the page, and the message was queued into the running errand as well. Its outcome still arrives as a new message.",
          runId,
          status: row.status,
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
          allowSubmit,
          collectImages: input.collectImages === true,
          errand: row.task,
          facts: facts.details,
          message: withCodeEntry(message, codeEntry),
          searching: followUpSearches(message, row.outcome),
          site,
        }),
      });
      if (!followUp.run) {
        await queueBrowserUseSessionMessage(
          row.sessionId,
          withCodeEntry(message, codeEntry)
        );
        return {
          note: "The browser session was busy with another run, so the message was queued onto it instead. Keep using this run id; the outcome arrives as a new message.",
          runId,
          status: row.status,
        };
      }

      await createBrowserRun(scope, {
        ...conversation,
        id: followUp.run.id,
        liveViewUrl: followUp.reusedSession ? row.liveViewUrl : null,
        profileId,
        sessionId: followUp.run.sessionId,
        site: site ?? null,
        status: "running",
        task: message,
      });
      const inheritedLiveViewUrl = followUp.reusedSession
        ? row.liveViewUrl
        : null;
      const liveViewUrl =
        inheritedLiveViewUrl ?? (await waitForLiveViewUrl(followUp.run.id));
      if (liveViewUrl && liveViewUrl !== row.liveViewUrl) {
        await updateBrowserRunProgress(followUp.run.id, { liveViewUrl });
      }
      return {
        boundSecrets: secrets.aliases,
        liveViewUrl,
        note: [
          `This errand now continues as run ${followUp.run.id}${followUp.reusedSession ? " in the same browser" : ""}. Use that run id from here on: ${runId} is finished and takes no further follow-up.`,
          followUp.reusedSession
            ? undefined
            : "The previous browser session was not reused — it was gone, or it had ended against an anti-bot check — so the follow-up opened a fresh browser on the same profile, on a new address; the signed-in cookies came with it.",
          "The outcome arrives as a new message; do not poll for it.",
        ]
          .filter((line) => line !== undefined)
          .join(" "),
        previousRunId: runId,
        runId: followUp.run.id,
        status: "running",
      };
    }

    if (input.action === "cancel") {
      await cancelBrowserUseRun(runId);
      await claimBrowserRunCompletion(runId, {
        outcome: "The user cancelled this browser run.",
        status: "stopped",
      });
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
      note: undelivered
        ? "This outcome never reached the conversation as its own message. Tell the user what happened now."
        : undefined,
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

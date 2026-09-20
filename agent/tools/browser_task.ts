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
  readBrowserProfileId,
  readBrowserRunForScope,
  saveBrowserProfileId,
  updateBrowserRunProgress,
} from "@db/services/browser-runs";
import { browserRunFacts } from "@agent/lib/browser-use/facts";
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
  runId: z
    .string()
    .min(1)
    .optional()
    .describe("The run id returned by start. Required for every other action."),
  site: z
    .string()
    .optional()
    .describe(
      "The website origin the errand is about, such as https://www.example.com. Saved credentials are bound to this origin only."
    ),
  task: z
    .string()
    .min(1)
    .max(8_000)
    .optional()
    .describe(
      "For start, the errand in the user's own language. For continue, the answer, code, or changed constraint to pass into the running errand."
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
    "Finish your final answer with these labelled lines, written in the language of the errand above:",
    "RESULT: what was actually accomplished, or why it stopped",
    "ORDER: the order, booking, or reference number, or none",
    "TOTAL: the amount charged or shown, or none",
    `NEEDS: exactly one of ${browserRunNeeds.join(", ")}`,
    "DETAILS: the one thing a person must supply or decide, or none",
  ].join("\n");
}

function credentialsLine(aliases: readonly string[]) {
  return aliases.length === 0
    ? "No stored credentials are available for this run. If the site asks you to sign in, stop with NEEDS: password instead of guessing one."
    : `Credentials are attached as secrets: focus the field and ask for the secret by name — ${aliases.join(", ")}. The server types the values; you never see them.`;
}

export function composeBrowserTask(options: {
  readonly aliases: readonly string[];
  readonly errand: string;
  readonly facts: string | undefined;
  readonly site: string | undefined;
}) {
  return [
    options.site
      ? `${options.errand}\n\nSite: ${options.site}`
      : options.errand,
    options.facts,
    credentialsLine(options.aliases),
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
 * sign-in the person is following up about.
 */
export function composeBrowserContinuation(options: {
  readonly aliases: readonly string[];
  readonly errand: string;
  readonly facts: string | undefined;
  readonly message: string;
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
    options.facts,
    credentialsLine(options.aliases),
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
  try {
    return { reusedSession: true, run: await createBrowserUseRun(input) };
  } catch (error) {
    if (!(error instanceof BrowserUseError)) throw error;
    if (error.status === 409) return { reusedSession: true, run: undefined };
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
    "Run one errand on a website through a hosted cloud browser that can sign in, fill forms, and complete a checkout. Use it when the user wants something done on a site; use web_search and web_fetch instead for reading public pages. Start exactly one run per errand and pass the site's origin so saved credentials can be bound to it. Write the errand short: the cloud browser is itself an agent, so give it the goal, the hard constraints, and what to report back — not a click-by-click script. Every follow-up for that errand — an answer, a code the user typed, a changed constraint — goes through continue with the same runId, never a second start: continue works in the same browser, on the tab and the signed-in account the run already has. When the previous run has already finished, continue starts a follow-up run in that same browser and returns a NEW runId; use that one from then on. Pass allowPayment: true on start or on continue once the user approved paying or attaching a card on this errand in this conversation — «привяжи карту» is approval to bind the saved card, not to buy anything. The person's name, phone, email and addresses from the profile and from the vault are typed into forms automatically, so never ask for a phone number or an address the user said is saved: start the errand and let the run use it. The run signs in with vault credentials the models involved never see, so never ask the user for a password: when none is stored, call request_vault_setup. Give the user the live-view link only when the run is blocked on a CAPTCHA, 3-D Secure, a push approval, or a sign-in you cannot complete, and never forward a one-time code back to the user. The run continues in the background and its result arrives later as a new message, so do not wait on it.",
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
        errand,
        facts,
        site: input.site,
      });
      const run = await createBrowserUseRun({
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
      const site = input.site ?? row.site ?? undefined;
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
      const followUp = await createFollowUpRun({
        maxCostUsd: env.BROWSER_USE_MAX_COST_USD,
        model: env.BROWSER_USE_MODEL,
        profileId,
        proxyCountryCode: env.BROWSER_USE_PROXY_COUNTRY,
        secretBindings: secrets.bindings,
        sessionId: row.sessionId,
        task: composeBrowserContinuation({
          aliases: secrets.aliases,
          errand: row.task,
          facts,
          message: withCodeEntry(message, codeEntry),
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
          `This errand now continues as run ${followUp.run.id} in the same browser. Use that run id from here on: ${runId} is finished and takes no further follow-up.`,
          followUp.reusedSession
            ? undefined
            : "The previous browser session was gone, so the follow-up opened a new one on the same profile; the signed-in cookies came with it.",
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
    return {
      liveViewUrl: row.liveViewUrl ?? undefined,
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

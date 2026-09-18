import type { ToolContext } from "eve/tools";
import { defineDynamic, defineTool } from "eve/tools";
import { z } from "zod";
import { resolveModeValue } from "@agent/lib/mode";
import { scopeFromPrincipal } from "@agent/lib/principal-scope";
import {
  browserUseConfigured,
  cancelBrowserUseRun,
  createBrowserUseProfile,
  createBrowserUseRun,
  listBrowserUseRunEvents,
  liveViewUrlFromEvents,
  queueBrowserUseSessionMessage,
  readBrowserUseRunStatus,
} from "@agent/lib/browser-use/client";
import { resolveBrowserSecretBindings } from "@agent/lib/browser-use/secrets";
import {
  claimBrowserRunCompletion,
  createBrowserRun,
  readBrowserProfileId,
  readBrowserRunForScope,
  saveBrowserProfileId,
  updateBrowserRunProgress,
} from "@db/services/browser-runs";
import { readUserProfile } from "@db/services/user-profile";
import { env } from "@shared/environment";
import { browserRunNeeds } from "@agent/lib/browser-use/outcome";

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

function knownFacts(profile: Awaited<ReturnType<typeof readUserProfile>>) {
  const name = [profile.firstName, profile.lastName]
    .filter((part) => part !== null)
    .join(" ");
  const address = [
    profile.addressLine1,
    profile.addressLine2,
    profile.postalCode,
    profile.city,
    profile.region,
    profile.countryCode,
  ]
    .filter((part) => part !== null)
    .join(", ");
  const facts = [
    name ? `Name: ${name}` : undefined,
    profile.phone ? `Phone: ${profile.phone}` : undefined,
    profile.email ? `Email: ${profile.email}` : undefined,
    address ? `Address: ${address}` : undefined,
  ].filter((fact) => fact !== undefined);
  return facts.length === 0
    ? undefined
    : ["Known details you may type into forms:", ...facts].join("\n");
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
    options.aliases.length === 0
      ? "No stored credentials are available for this run. If the site asks you to sign in, stop with NEEDS: password instead of guessing one."
      : `Credentials are attached as secrets: focus the field and ask for the secret by name — ${options.aliases.join(", ")}. The server types the values; you never see them.`,
    outcomeContract(),
  ]
    .filter((part) => part !== undefined)
    .join("\n\n");
}

function conversationTarget(context: ToolContext) {
  const auth = context.session.auth.current ?? context.session.auth.initiator;
  if (auth?.principalType !== "user") {
    throw new Error("An authenticated user is required to run a browser task.");
  }
  const conversationChannel = z
    .enum(["eve", "photon"])
    .parse(auth.attributes.conversationChannel);
  const conversationId =
    conversationChannel === "eve"
      ? context.session.id
      : z.string().min(1).parse(auth.attributes.conversationId);
  const replyAnchorMessageId = z
    .string()
    .min(1)
    .safeParse(auth.attributes.photonMessageId);
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
  const profile = await createBrowserUseProfile(
    "OpenInstinct workspace",
    scope.userId
  );
  return saveBrowserProfileId(scope, profile.id);
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
    "Run one errand on a website through a hosted cloud browser that can sign in, fill forms, and complete a checkout. Use it when the user wants something done on a site; use web_search and web_fetch instead for reading public pages. Start exactly one run per errand and pass the site's origin so saved credentials can be bound to it. Every follow-up for that errand — an answer, a code the user typed, a changed constraint — goes through continue with the same runId, never a second start. Set allowPayment only after the user approved paying on this errand in this conversation. The run signs in with vault credentials the models involved never see, so never ask the user for a password: when none is stored, call request_vault_setup. Give the user the live-view link only when the run is blocked on a CAPTCHA, 3-D Secure, a push approval, or a sign-in you cannot complete. The run continues in the background and its result arrives later as a new message, so do not wait on it.",
  inputSchema,
  async execute(input, context) {
    const { conversation, scope } = conversationTarget(context);

    if (input.action === "start") {
      const errand = z
        .string()
        .min(1, "A start action needs the errand text.")
        .parse(input.task);
      const [profileId, secrets, profile] = await Promise.all([
        workspaceProfileId(scope),
        resolveBrowserSecretBindings(scope, {
          allowPayment: input.allowPayment === true,
          site: input.site,
        }),
        readUserProfile(scope),
      ]);
      const task = composeBrowserTask({
        aliases: secrets.aliases,
        errand,
        facts: knownFacts(profile),
        site: input.site,
      });
      const run = await createBrowserUseRun({
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
      await queueBrowserUseSessionMessage(row.sessionId, message);
      return {
        note: "The message was queued into the running errand. Its outcome still arrives as a new message.",
        runId,
        status: row.status,
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

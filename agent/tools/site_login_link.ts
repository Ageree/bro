import { defineDynamic, defineTool, type ToolContext } from "eve/tools";
import { z } from "zod";
import {
  personMessages,
  personWordsThisTurn,
} from "@agent/lib/browser-use/said";
import { usesBrowserVm } from "@agent/lib/browser-vm/backend";
import {
  linkLifetimeMs,
  loginHandoffLink,
  newLinkId,
} from "@agent/lib/login-handoff/open";
import { loginHandoffPilot } from "@agent/lib/login-handoff/pilot";
import { handoffSite, namedInWords } from "@agent/lib/login-handoff/site";
import { resolveModeValue, startedByPerson } from "@agent/lib/mode";
import { scopeFromPrincipal } from "@agent/lib/principal-scope";
import { scheduleOwner, scheduleReplyAnchor } from "@agent/lib/schedules/tools";
import {
  stepIdentity,
  stepStartedEventSchema,
} from "@agent/lib/turn-kind/step";
import { createLoginHandoff } from "@db/services/login-handoffs";

const inputSchema = z.object({
  site: z
    .string()
    .trim()
    .min(3)
    .max(300)
    .describe(
      "The site the person signs in to, as they named it: its domain (ozon.ru) or a link they sent."
    ),
  signInPage: z
    .string()
    .trim()
    .max(500)
    .optional()
    .describe(
      "The address of the site's own sign-in form (https://www.ozon.ru/login), on the same site. Find it first (open the site's «Войти» link with web_fetch or a search) so the person lands on the form, not on the home page. Leave out only when you could not find it."
    ),
});

const notThePerson =
  "Nothing was sent: a sign-in link is made only in a turn the person's own message opened.";
const notTheirSite =
  "Nothing was sent: the site must be one the person named in this conversation (its domain or a link). Ask which site, and its address.";

/**
 * The person's words a link is checked against, taken before each step:
 * their messages, one steered into the turn included, and their answers to
 * Bro's questions. `personsTurn`: whether their own message opened this turn
 * — not a browser report, a schedule or a task agent's report, whose text a
 * page wrote.
 */
interface LinkWords {
  readonly personsTurn: boolean;
  readonly said: readonly string[];
}

async function createLink(
  input: z.output<typeof inputSchema>,
  context: ToolContext,
  { personsTurn, said }: LinkWords
) {
  if (!startedByPerson(context) || !personsTurn) {
    throw new Error(notThePerson);
  }
  const site = handoffSite(input.site);
  if (site.kind === "refused") {
    return site.reason === "gosuslugi"
      ? {
          reply:
            "Госуслуги and the sites that sign in through them ask for a new code on every new device whatever the browser keeps, so a link would not help. Say so, and that Bro asks for the code in the chat when an errand needs it. Nothing was sent.",
          sent: false,
        }
      : {
          reply:
            "That is not a site address Bro can open (a domain such as ozon.ru is needed). Ask the person which site. Nothing was sent.",
          sent: false,
        };
  }
  if (!namedInWords(site.domain, said)) throw new Error(notTheirSite);
  // The window opens on the sign-in form when the model found it, but only on
  // the site the person named (or its own sign-in domain): a page may not
  // steer the window elsewhere.
  let openAt = site.url;
  if (input.signInPage !== undefined && input.signInPage !== "") {
    const page = handoffSite(input.signInPage);
    if (page.kind !== "ok" || !site.allowedDomains.includes(page.domain)) {
      return {
        reply:
          "That sign-in page is not on the site the person named. Find the form on the site itself and call again with its address, or leave signInPage out. Nothing was sent.",
        sent: false,
      };
    }
    openAt = page.url;
  }
  const owner = scheduleOwner(context);
  if (!(await usesBrowserVm({ ...owner.scope }))) {
    return {
      reply:
        "This deployment's browser cannot show a sign-in window yet. Say so plainly: Bro signs in itself and asks for the codes in the chat. Nothing was sent.",
      sent: false,
    };
  }
  const now = new Date();
  const id = newLinkId();
  const created = await createLoginHandoff(
    {
      allowedDomains: [...site.allowedDomains],
      conversationChannel: owner.conversation.conversationChannel,
      conversationId: owner.conversation.conversationId,
      createdByUserId: owner.scope.userId,
      domain: site.domain,
      expiresAt: new Date(now.getTime() + linkLifetimeMs),
      id,
      replyAnchorMessageId: scheduleReplyAnchor(context) ?? null,
      rootSessionId: context.session.id,
      siteUrl: openAt,
      workspaceId: owner.scope.workspaceId,
    },
    now
  );
  if (created.kind === "busy") {
    return {
      reply:
        "Another sign-in window of this person is open right now. Say so: they can finish or close that one, then ask again. Nothing was sent.",
      sent: false,
    };
  }
  return {
    link: loginHandoffLink(id),
    reply: `The link is made. Send it to the person as it is, on a line of its own, with: it opens a window of Bro's own browser on ${site.domain}, where they sign in themselves (type the login, password and any code right there, and tick «Запомнить меня» if the site offers it), then press «Готово»; Bro does not keep the password, and Bro stays signed in there for later errands. The link works for 30 minutes from one device, so they must not forward it. Do not open the link, do not ask for the password or a code in the chat, and say nothing more until they answer or the result comes.`,
    sent: true,
  };
}

export default defineDynamic({
  events: {
    // Only the pilot (LOGIN_HANDOFF_WORKSPACES) gets the tool, the same at
    // every step. What the person wrote is taken before each step, so a
    // message steered into the turn and an answer to Bro's question count: the
    // site of a link is checked against their words, never the model's.
    "step.started": async (event, context) => {
      const auth = context.session.auth.current;
      if (resolveModeValue(context, { interactive: true }) !== true) {
        return null;
      }
      if (auth?.principalType !== "user") return null;
      if (!(await loginHandoffPilot(scopeFromPrincipal(auth)))) return null;
      const turn = personWordsThisTurn(
        context.messages,
        stepIdentity(
          stepStartedEventSchema.safeParse(event).data,
          context.session.id
        )
      );
      const words: LinkWords = {
        personsTurn: turn.said !== null,
        // The labels of options the person picked are Bro's own words, which
        // a page may have suggested: only what they typed counts.
        said: [
          ...personMessages(context.messages),
          ...turn.answers.filter((answer) => !turn.picked?.includes(answer)),
        ],
      };
      return {
        "site-login-link": defineTool({
          description:
            "Make a link where the person signs in to a site themselves, in a window of Bro's own browser, once; Bro then stays signed in there for later errands. Use it when an errand needs the person's account on a site and they are not signed in there (the browser asked for a password or code), or when they ask to sign in to a site in Bro's browser. The site must be one they named. Before calling it, find the site's sign-in form address (web_fetch the site, follow its «Войти» link) and pass it as signInPage, so the window opens on the form and not on the home page. Never for Госуслуги. After it, send the link and wait: do not ask for the password or a code in the chat.",
          inputSchema,
          async execute(input, toolContext) {
            return createLink(input, toolContext, words);
          },
        }),
      };
    },
  },
});

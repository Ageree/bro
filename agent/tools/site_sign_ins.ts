import { defineDynamic, defineTool } from "eve/tools";
import { z } from "zod";
import { browserUseConfigured } from "@agent/lib/browser-use/client";
import {
  forgetSignIns,
  listKeptSignIns,
} from "@agent/lib/browser-use/sign-ins";
import { resolveModeValue, startedByPerson } from "@agent/lib/mode";
import { scopeFromPrincipal } from "@agent/lib/principal-scope";
import { env } from "@shared/environment";

/** How the keep-alive visits stand on this deployment, for the person. */
function keepAliveNote() {
  const days = env.BROWSER_USE_SIGN_IN_REFRESH_DAYS;
  return days === 0
    ? "Bro does not open these sites on its own on this deployment."
    : `Every ${String(days)} days Bro's browser opens the account page of each site marked signed_in that an errand used in the last month (never Госуслуги), clicks nothing there and closes it, so the sign-in does not expire.`;
}

export const siteSignIns = defineTool({
  description:
    "The sites where Bro's cloud browser keeps the person signed in from earlier errands, and forgetting them. action list: when the person asks where Bro is signed in on their behalf or which of their accounts it opens. action forget: when they ask Bro to forget their sign-ins on sites, to sign its browser out, or to stop opening their accounts on its own («забудь мои входы на сайты», «не заходи больше в мой Озон»). With site, only that site is forgotten: Bro stops opening it on its own, while its browser may stay signed in there. Without site, the browser profile is deleted with every cookie and sign-in: the next errand starts signed out everywhere. It never touches the vault's saved passwords.",
  inputSchema: z.object({
    action: z.enum(["list", "forget"]),
    site: z
      .string()
      .min(1)
      .max(200)
      .optional()
      .describe(
        "For forget: the one site to forget, as a domain such as ozon.ru. Leave it out to forget every site."
      ),
  }),
  async execute(input, context) {
    const auth = context.session.auth.current;
    if (auth?.principalType !== "user") {
      throw new Error("An authenticated user is required.");
    }
    const { workspaceId } = scopeFromPrincipal(auth);
    if (input.action === "list") {
      const sites = await listKeptSignIns(workspaceId);
      return {
        keepAlive: keepAliveNote(),
        note:
          sites.length === 0
            ? "Bro's browser has no sign-in on record for this person."
            : "Tell the person, in one message, the sites where Bro's browser is signed in (signed_in) and where it last found them signed out, and that they can ask to forget one site or all of them.",
        sites,
      };
    }
    const forgotten = await forgetSignIns(workspaceId, input.site);
    if (forgotten.kind === "unknown_site") {
      return {
        note: "That is not a site Bro can name: ask which site they mean.",
        status: "not_forgotten",
      };
    }
    if (forgotten.kind === "busy") {
      return {
        note: "An errand is still using Bro's browser, so its sign-ins cannot be forgotten right now. Tell the person so, and that they can ask again once the errand is done.",
        status: "not_forgotten",
      };
    }
    if (forgotten.kind === "site") {
      return {
        note: `Bro no longer opens ${forgotten.site} on its own and no longer counts on being signed in there. Its browser may still be signed in to that site until the person asks to forget every sign-in, or an errand there signs out. Say both plainly.`,
        site: forgotten.site,
        status: "forgotten",
      };
    }
    return {
      note: forgotten.profileDeleted
        ? "Bro's browser profile was deleted with every cookie and sign-in, and nothing is on record any more: the next errand starts signed out everywhere and signs in anew, asking for codes as a first sign-in does. Passwords saved in the vault stay. Say so plainly."
        : "Bro forgot every sign-in on record and will use a new, empty browser profile from the next errand, which signs in anew; the old profile could not be deleted in the cloud right now, and Bro no longer uses it. Passwords saved in the vault stay. Say so plainly.",
      sites: forgotten.domains,
      status: "forgotten",
    };
  },
});

export default defineDynamic({
  events: {
    // Only the person's own turn: forgetting deletes their browser profile,
    // and a page's text in a browser report must not be able to ask for it.
    "turn.started": (_event, context) =>
      browserUseConfigured() && startedByPerson(context)
        ? resolveModeValue(context, {
            interactive: { site_sign_ins: siteSignIns },
          })
        : null,
  },
});

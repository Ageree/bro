import { defineDynamic, defineTool } from "eve/tools";
import { defaultWebSearch } from "eve/tools/web_search";
import { resolveModeValue } from "@agent/lib/mode";
import { openRouterActive } from "@shared/model/provider";
import {
  searchWeb,
  webSearchInputSchema,
  type WebSearchResult,
} from "@agent/lib/web-search/openrouter";

export const openRouterWebSearch = defineTool({
  description:
    "Search the web for real-time information: current events, prices, places, services, schedules and anything that may have changed since the knowledge cutoff. Returns up to eight pages, each with its title, URL and an excerpt of what the page says; the excerpt often already shows a price, an average bill, opening hours or an address. Read a page with web_fetch when its excerpt is not enough.",
  inputSchema: webSearchInputSchema,
  async execute(input, ctx) {
    try {
      return formatResults(await searchWeb(input, ctx.abortSignal));
    } catch (error) {
      if (ctx.abortSignal.aborted) throw error;
      return `search failed: ${failureReason(error)}. Do not repeat this query as is: try one shorter or differently worded query${input.sites ? " or drop sites" : ""}, or read a page you already know with web_fetch.`;
    }
  },
});

function failureReason(cause: unknown) {
  if (!(cause instanceof Error)) return "the search could not be completed";
  return cause.name === "TimeoutError" ? "the search timed out" : cause.message;
}

function formatResults(results: readonly WebSearchResult[]) {
  return results
    .map((result, index) => {
      const heading = `${String(index + 1)}. ${result.title}\n${result.url}`;
      return result.snippet ? `${heading}\n${result.snippet}` : heading;
    })
    .join("\n\n");
}

/**
 * eve's `web_search` is provider-managed: an AI Gateway model searches through
 * Exa, and a direct-provider model is handed that provider's native search
 * tool. OpenRouter has neither, so eve emits the gateway tool as
 * `type: "gateway:exa_search"` into a chat-completions body that accepts only
 * `type: "function"`, and every turn fails validation. When OpenRouter owns
 * inference the agent therefore gets an ordinary function tool of our own.
 *
 * The choice is made once, at module load: eve rejects a provider-managed
 * definition returned from a dynamic resolver, which may only return
 * `defineTool()` values. `OPENROUTER_API_KEY` is present in the build
 * environment, so this is the same decision the runtime would make.
 *
 * The OpenRouter tool is ours, so it is withheld from Bro's own mail checks
 * and from report turns: a search query could carry what an untrusted email
 * asked it to. The gateway tool is provider-managed and cannot be gated per
 * mode.
 */
export default openRouterActive()
  ? defineDynamic({
      events: {
        "turn.started": (_event, context) =>
          resolveModeValue(context, {
            interactive: { web_search: openRouterWebSearch },
            "scheduled-worker": { web_search: openRouterWebSearch },
          }),
      },
    })
  : defaultWebSearch;

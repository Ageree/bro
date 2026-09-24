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
    "Search the web for real-time information. Use this to find up-to-date information about current events, recent developments, or topics that may have changed since the knowledge cutoff. Returns a short list of pages with their titles, URLs, and one-line summaries; read a page with web_fetch when its summary is not enough.",
  inputSchema: webSearchInputSchema,
  async execute(input) {
    try {
      return formatResults(await searchWeb(input));
    } catch (error) {
      const reason =
        error instanceof Error
          ? error.name === "TimeoutError"
            ? "the search timed out"
            : error.message
          : "the search could not be completed";
      return `search failed: ${reason}`;
    }
  },
});

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

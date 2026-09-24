import { defineDynamic, defineTool } from "eve/tools";
import { webFetch } from "eve/tools/web_fetch";
import { resolveModeValue } from "@agent/lib/mode";

export const webFetchTool = defineTool({
  description: webFetch.description,
  inputSchema: webFetch.inputSchema,
  label: {
    start: ({ url }) => `Fetch ${URL.parse(url)?.hostname ?? url}`,
  },
  outputSchema: webFetch.outputSchema,
  execute: (input, ctx) => webFetch.execute(input, ctx),
});

export default defineDynamic({
  events: {
    // Bro's own mail checks read untrusted mail, so they get no way to carry
    // what they read to a URL an email chose.
    "turn.started": (_event, context) =>
      resolveModeValue(context, {
        interactive: { web_fetch: webFetchTool },
        "scheduled-report": { web_fetch: webFetchTool },
        "scheduled-worker": { web_fetch: webFetchTool },
      }),
  },
});

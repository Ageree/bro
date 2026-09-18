import { defineTool } from "eve/tools";
import { webFetch } from "eve/tools/web_fetch";
import { tinyfishFetchPage } from "../lib/tinyfish.ts";
import { instinctBlocked } from "../lib/instinct-guard.ts";
import { turnAttributes } from "../lib/turn-attrs";

export default defineTool({
  ...webFetch,
  description: `${webFetch.description}

Bro reads the page through TinyFish Fetch (clean content, free). Not for login, pay, cart, or forms — those stay browser_task.`,
  async execute({ url, format, timeout }, ctx) {
    // eve types this tool's result as a page, so the refusal is delivered as
    // the page's own content rather than as a `status` the model would not be
    // able to read here anyway.
    const blocked = instinctBlocked(turnAttributes(ctx), "web_fetch");
    if (blocked) {
      return { url, content: blocked.hint, contentType: "text/plain", truncated: false };
    }
    return await tinyfishFetchPage({ url, format, timeout });
  },
});

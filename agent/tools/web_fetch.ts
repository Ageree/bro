import { defineTool } from "eve/tools";
import { webFetch } from "eve/tools/web_fetch";
import { tinyfishFetchPage } from "../lib/tinyfish.ts";

export default defineTool({
  ...webFetch,
  description: `${webFetch.description}

Bro reads the page through TinyFish Fetch (clean content, free). Not for login, pay, cart, or forms — those stay browser_task.`,
  async execute({ url, format, timeout }) {
    return await tinyfishFetchPage({ url, format, timeout });
  },
});

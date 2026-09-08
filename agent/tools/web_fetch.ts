import { defineTool } from "eve/tools";
import { z } from "zod";
import { tinyfishFetch } from "../lib/tinyfish.ts";

export default defineTool({
  description:
    "Read public pages as clean markdown. Pass 1-5 http(s) URLs from web_search or the human. Not for login, pay, cart, or forms — those stay browser_task.",
  inputSchema: z.object({
    urls: z.array(z.string().min(8).max(2000)).min(1).max(5),
  }),
  async execute({ urls }) {
    return await tinyfishFetch(urls);
  },
});

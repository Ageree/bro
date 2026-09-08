import { defineTool } from "eve/tools";
import { z } from "zod";
import { tinyfishSearch } from "../lib/tinyfish.ts";

export default defineTool({
  description:
    "Public web search. Facts, news, hours, official pages. Not WB/Ozon prices, carts, bookings, or logins — those stay browser_task. Then web_fetch the best URLs if snippets are thin.",
  inputSchema: z.object({
    query: z.string().min(1).max(2000),
    purpose: z.string().min(1).max(400).optional(),
    kind: z.enum(["web", "news"]).optional(),
    location: z.string().min(2).max(2).optional(),
  }),
  async execute({ query, purpose, kind, location }) {
    return await tinyfishSearch({ query, purpose, kind, location });
  },
});

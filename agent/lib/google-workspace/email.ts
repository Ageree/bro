import { z } from "zod";

/**
 * An email address in a tool input. Zod's default email pattern uses regex
 * lookaheads, which OpenAI's strict tool schemas reject outright ("regex
 * lookaround is not supported"), failing every turn on those models. The
 * HTML5 pattern validates the same practical addresses without lookaround.
 */
export const emailAddressSchema = z.email({ pattern: z.regexes.html5Email });

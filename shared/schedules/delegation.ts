import * as z from "zod";
import { browserSubmissionSchema } from "@shared/browser/submission";

/**
 * The free action a person delegated to a schedule in their own message,
 * kept in the schedule itself (`scheduled_agent_jobs.delegation`): each run
 * may do exactly this and nothing else. What a page, a letter or a browser
 * report says never widens it, and it never pays.
 *
 * - `browser`: one submission on one site, held to `chargeRub: 0`.
 * - `email`: a letter to exactly these addresses, about this.
 */
export const scheduleDelegationSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("browser"),
    site: z
      .string()
      .trim()
      .min(1)
      .max(300)
      .describe(
        "The site's origin, such as https://www.example.com: the run submits only there."
      ),
    submission: browserSubmissionSchema
      .extend({
        chargeRub: z
          .number()
          .min(0)
          .max(0)
          .describe("Always 0: a schedule never pays in the person's name."),
      })
      .describe(
        "Exactly what each run submits in the person's name, as browser_task's submission: the kind, what, where, for whom, which details, and the date, slot or the window the person named."
      ),
  }),
  z.object({
    kind: z.literal("email"),
    to: z
      .array(z.email({ pattern: z.regexes.html5Email }))
      .min(1)
      .max(5)
      .describe(
        "Every address the letter goes to, exactly as the person named them or as their contacts hold them."
      ),
    about: z
      .string()
      .trim()
      .min(1)
      .max(500)
      .describe(
        "What the letter says, in the person's words: «показания счётчиков за месяц»."
      ),
  }),
]);

export type ScheduleDelegation = z.infer<typeof scheduleDelegationSchema>;

/** The delegation a schedule row holds: one that no longer parses is none. */
export const storedDelegationSchema = scheduleDelegationSchema
  .nullable()
  .catch(null);

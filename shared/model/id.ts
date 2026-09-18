import { z } from "zod";

/**
 * The AI Gateway and OpenRouter both address a model as `provider/model`, so a
 * single shape validates a workspace selection in either routing mode.
 */
export const modelIdSchema = z
  .string()
  .trim()
  .min(1)
  .max(300)
  .regex(/^[\w.-]+\/[\w.:-]+$/u, "Use a provider/model id.");

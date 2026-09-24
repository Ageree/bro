import { z } from "zod";

/**
 * How Bro addresses the person: «ты» unless they asked for «вы», and the name
 * they asked to be called by, if any. It is a workspace setting rather than a
 * memory record, so every chat, channel and session reads the same value and
 * the model is reminded of it on every step instead of finding it in the
 * middle of the profile.
 */
export const formOfAddressSchema = z.object({
  formal: z.boolean(),
  // Only a name: it is read back to the model on every step, so it may not
  // carry anything that reads like an instruction. A refine rather than a
  // regex keeps the Unicode pattern out of the tool's JSON Schema, which some
  // providers validate with a regex dialect that lacks `\p{…}`.
  name: z
    .string()
    .trim()
    .min(1)
    .max(40)
    .refine(
      (value) =>
        /^\p{L}[\p{L}\p{M}'-]*(?: \p{L}[\p{L}\p{M}'-]*){0,2}$/u.test(value),
      "Up to three words of letters, apostrophes and hyphens"
    )
    .nullable(),
});

export type FormOfAddress = z.infer<typeof formOfAddressSchema>;

/** Bro's own voice is informal until the person asks otherwise. */
export const defaultFormOfAddress: FormOfAddress = {
  formal: false,
  name: null,
};

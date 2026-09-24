import { defineDynamic, defineTool } from "eve/tools";
import { z } from "zod";
import { resolveModeValue } from "@agent/lib/mode";
import { scopeFromPrincipal } from "@agent/lib/principal-scope";
import { formOfAddressSchema } from "@shared/chat/form-of-address";
import { updateFormOfAddress } from "@db/services/settings";

export const formOfAddress = defineTool({
  description:
    "Save how the person wants to be addressed, for every chat and channel from now on. Call with formal=true when they ask to switch to «вы» («давай на вы», «обращайся ко мне на вы»), formal=false when they ask for «ты» («можно на ты», «давай на ты»). Call with name when they ask to be called by a particular name («зови меня Саша»), name=null when they ask to drop it. Use this, not profile__save_memory, for «ты»/«вы» and the name to call them; their legal name for forms goes to personal_info. Switch to the new form in the reply right away.",
  inputSchema: z
    .object({
      formal: formOfAddressSchema.shape.formal.optional(),
      name: formOfAddressSchema.shape.name.optional(),
    })
    .refine(
      (input) => input.formal !== undefined || input.name !== undefined,
      "Pass formal, name, or both."
    ),
  async execute(input, ctx) {
    const auth = ctx.session.auth.current;
    if (auth?.principalType !== "user") {
      throw new Error("An authenticated user is required.");
    }
    return {
      formOfAddress: await updateFormOfAddress(scopeFromPrincipal(auth), input),
    };
  },
});

export default defineDynamic({
  events: {
    "turn.started": (_event, context) =>
      resolveModeValue(context, {
        interactive: { form_of_address: formOfAddress },
      }),
  },
});

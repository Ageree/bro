import type { ToolContext } from "eve/tools";
import { z } from "zod";
import { googleUrl, withGoogleAuth } from "./client";

/** The People API, where Google Contacts live. */
const peopleApi = "https://people.googleapis.com/v1";

const readMask = "names,emailAddresses,phoneNumbers,organizations";

const contactValuesSchema = z
  .array(
    z.object({ type: z.string().optional(), value: z.string().optional() })
  )
  .optional();

/** A contact search as Google answers it, the fields in `readMask`. */
const contactSearchSchema = z.object({
  results: z
    .array(
      z.object({
        person: z
          .object({
            emailAddresses: contactValuesSchema,
            names: z
              .array(z.object({ displayName: z.string().optional() }))
              .optional(),
            organizations: z
              .array(
                z.object({
                  name: z.string().optional(),
                  title: z.string().optional(),
                })
              )
              .optional(),
            phoneNumbers: contactValuesSchema,
            resourceName: z.string().optional(),
          })
          .optional(),
      })
    )
    .optional(),
});

export async function searchGoogleContacts(
  ctx: ToolContext,
  query: string,
  pageSize: number
) {
  return withGoogleAuth(ctx, async (google) => {
    // Google asks for one empty search to warm its cache before a real one.
    await google.json(contactSearchSchema, {
      url: googleUrl(peopleApi, "/people:searchContacts", {
        query: "",
        readMask,
      }),
    });
    const found = await google.json(contactSearchSchema, {
      url: googleUrl(peopleApi, "/people:searchContacts", {
        pageSize,
        query,
        readMask,
      }),
    });
    return { contacts: found.results ?? [] };
  });
}

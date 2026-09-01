import { defineTool } from "eve/tools";
import { z } from "zod";
import { listVaultItems } from "../../../lib/convex";
import { workerTenant } from "../lib/scope";

export default defineTool({
  description:
    "List opaque handles and safe metadata for this person's vault items. Returns only handle, kind, label, account, origin, and availability — never a secret value or anything derived from a decrypted secret.",
  inputSchema: z.object({}),
  async execute(_input, ctx) {
    const items = await listVaultItems(workerTenant(ctx));
    return items.map(({ account, available, handle, kind, label, origin }) => ({
      account,
      available,
      handle,
      kind,
      label,
      origin,
    }));
  },
});

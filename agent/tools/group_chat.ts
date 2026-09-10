import { defineTool } from "eve/tools";
import { z } from "zod";
import { PHOTON_GROUPS_PAUSED } from "../../convex/lib/photonPolicy.ts";
import { groupHowtoText } from "../../convex/lib/groupChatPolicy.ts";
import { isGroupTurn } from "../lib/group-guard";

export default defineTool({
  description:
    "iMessage groups are paused on Photon Pro. howto explains that Bro is 1:1 only for now. create is refused.",
  inputSchema: z.object({
    action: z.enum(["howto", "create"]).default("howto"),
    phones: z.array(z.string().min(8).max(20)).max(8).optional(),
    text: z.string().min(1).max(500).optional(),
  }),
  async execute({ action }, ctx) {
    void ctx;
    if (action === "howto") {
      return `${groupHowtoText()}\n\n${PHOTON_GROUPS_PAUSED}`;
    }
    if (isGroupTurn(ctx)) {
      return "Уже в группе. Новый чат открывай из лички.";
    }
    return PHOTON_GROUPS_PAUSED;
  },
});

import { parseArgs } from "node:util";
import { z } from "zod";
import { registerApplicationModuleResolution } from "../lib/module-resolution.ts";

registerApplicationModuleResolution();

const { values } = parseArgs({
  options: {
    workspace: { type: "string" },
    number: { type: "string" },
    "number-id": { type: "string" },
    "sip-id": { type: "string" },
    "phone-number-id": { type: "string" },
    "outbound-phone-number-id": { type: "string" },
    "session-id": { type: "string" },
    "conversation-id": { type: "string" },
    channel: { type: "string" },
    "paid-setup-rub": { type: "string" },
    "confirm-existing-paid-number": { type: "boolean" },
  },
});

const { db } = await import("@db");
try {
  if (values["confirm-existing-paid-number"] !== true)
    throw new Error(
      "Explicit --confirm-existing-paid-number is required; this command only binds an already-paid verified resource."
    );
  const { env } = await import("@shared/environment");
  const { readWorkspaceScope } = await import("@db/services/scope");
  const { adoptPhoneNumber, phonePilot } = await import("@db/services/phone");
  const { domesticPhoneSchema } = await import("@shared/phone/policy");
  const { requirePhoneAgentReady, verifyPhoneBinding } =
    await import("@shared/phone/elevenlabs");
  const { telegramConversationIdSchema } =
    await import("@agent/lib/telegram-conversation");
  const workspaceId = z.string().min(1).parse(values.workspace);
  const scope = await readWorkspaceScope(workspaceId);
  if (!scope || !phonePilot(scope))
    throw new Error(
      "Existing trusted owner and enabled phone pilot are required."
    );
  const resource = {
    number: domesticPhoneSchema.parse(values.number),
    numberId: z.string().min(1).parse(values["number-id"]),
    sipId: z.string().min(1).parse(values["sip-id"]),
    phoneNumberId: z.string().min(1).parse(values["phone-number-id"]),
    outboundPhoneNumberId: z
      .string()
      .min(1)
      .parse(values["outbound-phone-number-id"]),
    agentId: z.string().min(1).parse(env.PHONE_AGENT_ID),
    setupRub: z.coerce
      .number()
      .int()
      .nonnegative()
      .parse(values["paid-setup-rub"]),
  };
  const sessionId = z.string().min(1).parse(values["session-id"]);
  const conversationChannel = z
    .enum(["eve", "photon", "telegram"])
    .parse(values.channel);
  const conversationId =
    conversationChannel === "eve"
      ? sessionId
      : conversationChannel === "telegram"
        ? telegramConversationIdSchema.parse(values["conversation-id"])
        : z.string().startsWith("imessage:").parse(values["conversation-id"]);
  await requirePhoneAgentReady();
  const fees = await verifyPhoneBinding(resource);
  await adoptPhoneNumber(
    scope,
    { ...resource, ...fees },
    { sessionId, conversationId, conversationChannel }
  );
  console.info(
    "Existing verified dedicated phone adopted. No purchase, configuration mutation or call was made."
  );
} catch {
  console.error(
    "Phone adoption failed; no provider mutation was requested. Check the explicit resource mapping, readiness, fees, owner, uniqueness and pilot configuration."
  );
  process.exitCode = 1;
} finally {
  if ("end" in db.$client) await db.$client.end();
}

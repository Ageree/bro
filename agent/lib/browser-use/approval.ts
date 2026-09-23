import type { ApprovalContext, ApprovalStatus } from "eve/tools/approval";
import { z } from "zod";
import { scopeFromPrincipal } from "@agent/lib/principal-scope";
import { getBrowserAutonomyPolicy } from "@db/services/browser-autonomy";
import {
  browserCapabilitySchema,
  browserConsequentialCapabilitySchema,
} from "@shared/browser/autonomy";

const browserApprovalInputSchema = z.object({
  action: z.enum(["start", "continue", "cancel", "status"]),
  capability: browserCapabilitySchema.optional(),
  allowPayment: z.boolean().optional(),
});

export async function browserTaskApproval(
  context: ApprovalContext
): Promise<ApprovalStatus> {
  const input = browserApprovalInputSchema.safeParse(context.toolInput);
  if (!input.success) return "user-approval";
  const auth = context.session.auth.current;
  if (auth?.principalType !== "user") {
    return { type: "denied", reason: "An authenticated user is required." };
  }
  let scope: ReturnType<typeof scopeFromPrincipal>;
  try {
    scope = scopeFromPrincipal(auth);
  } catch {
    return {
      type: "denied",
      reason: "The authenticated user cannot access this workspace.",
    };
  }
  if (input.data.action === "cancel" || input.data.action === "status") {
    return "not-applicable";
  }

  const capability = input.data.capability;
  if (!capability) return "user-approval";
  if (input.data.allowPayment && capability !== "purchase") {
    return "user-approval";
  }
  if (capability === "browse" || capability === "prepare") {
    return "not-applicable";
  }

  try {
    const policy = await getBrowserAutonomyPolicy(scope);
    const consequential =
      browserConsequentialCapabilitySchema.parse(capability);
    return policy.grants.includes(consequential)
      ? "not-applicable"
      : "user-approval";
  } catch {
    return "user-approval";
  }
}

import { z } from "zod";

export const browserCapabilitySchema = z.enum([
  "browse",
  "prepare",
  "purchase",
  "send",
  "account-change",
  "delete",
]);

export type BrowserCapability = z.infer<typeof browserCapabilitySchema>;

export const browserConsequentialCapabilitySchema = z.enum([
  "purchase",
  "send",
  "account-change",
  "delete",
]);

export const browserAutonomyPolicySchema = z.object({
  version: z.literal(1),
  grants: z.array(browserConsequentialCapabilitySchema),
});

export type BrowserAutonomyPolicy = z.infer<typeof browserAutonomyPolicySchema>;

export const defaultBrowserAutonomyPolicy = {
  version: 1,
  grants: [],
} as const satisfies BrowserAutonomyPolicy;

export const broadBrowserAutonomyPolicy = {
  version: 1,
  grants: ["purchase", "send", "account-change", "delete"],
} as const satisfies BrowserAutonomyPolicy;

export function hasBroadBrowserAutonomy(policy: BrowserAutonomyPolicy) {
  return broadBrowserAutonomyPolicy.grants.every((capability) =>
    policy.grants.includes(capability)
  );
}

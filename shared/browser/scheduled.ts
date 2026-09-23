import { z } from "zod";

const scheduledBrowserOriginSchema = z.strictObject({
  leaseToken: z.uuid(),
  runId: z.uuid(),
});

export type ScheduledBrowserOrigin = z.infer<
  typeof scheduledBrowserOriginSchema
>;

export const scheduledBrowserResultSchema = z.strictObject({
  browserRunId: z.string().min(1),
  conversationChannel: z.enum(["eve", "photon", "telegram"]),
  conversationId: z.string().min(1),
  createdByUserId: z.string().min(1),
  liveViewUrl: z.url().nullable(),
  outcome: z.string().min(1).max(20_000),
  rootSessionId: z.string().min(1).nullable(),
  scheduledOrigin: scheduledBrowserOriginSchema.nullable(),
  task: z.string().min(1).max(8_000),
  workspaceId: z.string().min(1),
});

export type ScheduledBrowserResult = z.infer<
  typeof scheduledBrowserResultSchema
>;

export type ScheduledBrowserResultOwner = Pick<
  ScheduledBrowserResult,
  | "conversationChannel"
  | "conversationId"
  | "createdByUserId"
  | "rootSessionId"
  | "scheduledOrigin"
  | "workspaceId"
>;

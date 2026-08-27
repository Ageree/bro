import { Crons } from "@convex-dev/crons";
import { components, internal } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import type { MutationCtx } from "../_generated/server";
import { cronName, delayMs } from "./wakeupPolicy";

const crons = new Crons(components.crons);

export async function hasCron(
  ctx: MutationCtx,
  id: Id<"wakeups">,
): Promise<boolean> {
  return (await crons.get(ctx, { name: cronName(id) })) !== null;
}

export async function unscheduleCron(
  ctx: MutationCtx,
  id: Id<"wakeups">,
): Promise<void> {
  const name = cronName(id);
  if ((await crons.get(ctx, { name })) === null) return;
  await crons.delete(ctx, { name });
}

export async function scheduleCron(
  ctx: MutationCtx,
  id: Id<"wakeups">,
  at: number,
  now: number,
  gen: number,
): Promise<void> {
  await unscheduleCron(ctx, id);
  await crons.register(
    ctx,
    { kind: "interval", ms: delayMs(at, now) },
    internal.wakeups.dispatchOne,
    { id, gen },
    cronName(id),
  );
}

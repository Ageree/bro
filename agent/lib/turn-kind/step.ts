import { z } from "zod";

/**
 * What eve's `step.started` event carries of the step
 * (`StepStartedStreamEvent`). A resolver called without it — a test, the
 * measurement script — gets `{}`, which parses as no step.
 */
export const stepStartedEventSchema = z.object({
  data: z
    .object({
      stepIndex: z.number().int().nonnegative().optional(),
      turnId: z.string().min(1).optional(),
    })
    .optional(),
});

/** One step of one turn, as a `step.started` resolver sees it. */
export interface StepIdentity {
  readonly sessionId: string;
  readonly stepIndex?: number;
  readonly turnId?: string;
}

/** The session, turn and step a `step.started` resolver runs for. */
export function stepIdentity(
  event: z.infer<typeof stepStartedEventSchema> | undefined,
  sessionId: string
): StepIdentity {
  const turnId = event?.data?.turnId;
  const stepIndex = event?.data?.stepIndex;
  if (turnId === undefined) return { sessionId };
  return stepIndex === undefined
    ? { sessionId, turnId }
    : { sessionId, stepIndex, turnId };
}

/** eve numbers turns per session, so the key needs both. */
function turnKey(step: StepIdentity) {
  return step.turnId === undefined
    ? undefined
    : `${step.sessionId}\n${step.turnId}`;
}

/** Enough for every turn running on an instance at once. */
const rememberedTurns = 1000;

/**
 * A value per turn, kept on the instance for the last `rememberedTurns`
 * turns used: moved to the newest end as it is read or written, the oldest
 * goes first. A step without a turn id has none. Another instance, or this
 * one after a restart, has none of it either: a reader must hold safe
 * without it.
 */
export function turnMemory<T>() {
  const values = new Map<string, T>();
  const put = (key: string, value: T) => {
    values.delete(key);
    values.set(key, value);
    if (values.size <= rememberedTurns) return;
    const oldest = values.keys().next().value;
    if (oldest !== undefined) values.delete(oldest);
  };
  return {
    get(step: StepIdentity) {
      const key = turnKey(step);
      if (key === undefined) return undefined;
      const value = values.get(key);
      if (value !== undefined) put(key, value);
      return value;
    },
    set(step: StepIdentity, value: T) {
      const key = turnKey(step);
      if (key !== undefined) put(key, value);
    },
  };
}

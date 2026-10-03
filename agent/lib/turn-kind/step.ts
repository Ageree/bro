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

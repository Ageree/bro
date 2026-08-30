import { defineTool } from "eve/tools";
import { z } from "zod";
import {
  decideCallRoute,
  hostedReason,
  inkboxPlaceBody,
  parseCallEnv,
} from "../../convex/lib/callPolicy.ts";
import {
  attachCallBridge,
  attachCallInkbox,
  dropCallLeg,
  parkCallLeg,
  startExolveCallback,
  startVoxCallback,
  upsertTenant,
  waitJob,
} from "../lib/convex";
import { placeCall, setHostedAgentInstructions } from "../lib/inkbox";
import { tenantId } from "../lib/tenant";

export default defineTool({
  description:
    "Place an outbound phone call via Inkbox Voice AI. Russian +7 numbers go through a Twilio +1 hairpin: Inkbox dials the Twilio DID, TwiML Dial bridges to the clinic. Confirm with the human before the first call of a job. After placing, park the job with job_wait waitingFor=call if you did not pass jobId here.",
  inputSchema: z.object({
    dest: z
      .string()
      .min(5)
      .max(32)
      .describe("Clinic/restaurant number: +7…, 8…, or 495…"),
    task: z
      .string()
      .min(1)
      .max(1500)
      .describe("What Bro should say/do on the call, in the user's language"),
    callerName: z.string().max(80).optional(),
    jobId: z.string().optional(),
  }),
  async execute({ dest, task, callerName, jobId }, ctx) {
    const phone = tenantId(ctx);
    await upsertTenant(phone);
    const env = parseCallEnv(process.env);
    const decision = decideCallRoute(dest, env);
    if (decision.route === "blocked") {
      return { error: decision.error };
    }
    const fromE164 = env.inkboxFromE164;
    if (!fromE164) return { error: "no Inkbox phone number" };

    const reason = hostedReason({
      destE164: decision.destE164,
      task,
      callerName,
    });
    const parked = await parkCallLeg({
      tenantPhone: phone,
      destE164: decision.destE164,
      reason,
      route: decision.route,
      jobId,
    });
    if ("error" in parked) return parked;

    let placedId: string;
    try {
      if (decision.route === "exolve_callback") {
        await setHostedAgentInstructions(reason);
        const started = await startExolveCallback({
          destE164: decision.destE164,
          inkboxE164: fromE164,
          requestId: parked._id,
        });
        if ("error" in started) throw new Error(started.error);
        placedId = started.callId;
        await attachCallBridge(parked._id, placedId).catch((err) =>
          console.error("attach exolve call id failed", err),
        );
      } else if (decision.route === "vox_callback") {
        const cli = env.voxFromE164;
        if (!cli) throw new Error("VOXIMPLANT_FROM_E164 missing");
        await setHostedAgentInstructions(reason);
        const started = await startVoxCallback({
          destE164: decision.destE164,
          inkboxE164: fromE164,
          cliE164: cli,
        });
        if ("error" in started) throw new Error(started.error);
        placedId = started.mediaSessionId;
        await attachCallBridge(parked._id, placedId).catch((err) =>
          console.error("attach vox session id failed", err),
        );
      } else {
        const placed = await placeCall(
          inkboxPlaceBody({
            fromE164,
            dialE164: decision.dialE164,
            reason,
          }),
        );
        placedId = placed.id;
      }
    } catch (err) {
      await dropCallLeg(parked._id).catch((dropErr) =>
        console.error("drop call leg failed", dropErr),
      );
      return {
        error: err instanceof Error ? err.message : String(err),
      };
    }

    if (
      decision.route === "inkbox_direct" ||
      decision.route === "ru_bridge"
    ) {
      await attachCallInkbox(parked._id, placedId).catch((err) =>
        console.error("attach inkbox call id failed", err),
      );
    }

    if (jobId) {
      await waitJob(phone, jobId, "call", {
        note: `звонок ${decision.destE164}`,
        callDestE164: decision.destE164,
        callExternalId: placedId,
      }).catch((err) => console.error("job wait call failed", err));
    }

    return {
      id: placedId,
      destE164: decision.destE164,
      dialE164: decision.dialE164,
      route: decision.route,
      hint: jobId
        ? "Waiting on call.ended → [event:call]."
        : "If this is a job, job_wait waitingFor=call with this id.",
    };
  },
});

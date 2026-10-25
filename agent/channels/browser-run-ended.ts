import { defineChannel, POST } from "eve/channels";
import { z } from "zod";
import {
  type BrowserRunDelivery,
  settleBrowserRun,
} from "@agent/lib/browser-use/completion";
import {
  browserRunEndedPath,
  browserRunEndedSignatureValid,
} from "@agent/lib/browser-use/run-ended";
import { browserVmWorkspace } from "@agent/lib/browser-vm/ids";
import { fastDeliveryPilot } from "@agent/lib/browser-vm/pilot";
import { readBrowserRun } from "@db/services/browser-runs";

const endedSchema = z.object({ runId: z.string().min(1).max(300) });

/**
 * The word of a browser VM's worker that a run has ended
 * (BROWSER_FAST_DELIVERY_WORKSPACES), so that the run is settled and
 * reported at once instead of at the live watch's next look
 * (`agent/schedules/browser-runs.ts`, up to a minute with the gap between
 * its ticks). The word is signed with the VM's key and says nothing but the
 * run's name: what settles is read from the worker, as the watch reads it, so
 * a word that is wrong, early or sent twice costs a look and no more. The
 * watch stays as the fallback for a word that never comes.
 */
export default defineChannel({
  audience() {
    return "unknown";
  },
  receive() {
    throw new Error("The browser run channel only accepts the worker's word.");
  },
  routes: [
    POST(
      browserRunEndedPath,
      async (request, { attachSession, to, waitUntil }) => {
        const body = endedSchema.safeParse(
          await request.json().catch(() => undefined)
        );
        if (
          !body.success ||
          !browserRunEndedSignatureValid(
            body.data.runId,
            request.headers.get("x-bro-signature")
          )
        ) {
          return new Response(null, { status: 401 });
        }
        const { runId } = body.data;
        // A workspace taken out of the pilot hears no more from its VM.
        const pilot = await fastDeliveryPilot({
          workspaceId: browserVmWorkspace(runId),
        });
        if (!pilot || !(await readBrowserRun(runId))) {
          return new Response(null, { status: 202 });
        }
        waitUntil(settleQuietly({ attachSession, to }, runId));
        return new Response(null, { status: 202 });
      }
    ),
  ],
});

/** A settle that fails leaves the run to the live watch's next look. */
async function settleQuietly(delivery: BrowserRunDelivery, runId: string) {
  try {
    await settleBrowserRun(delivery, runId);
  } catch (error) {
    console.warn("[browser-use] a run's end could not be settled", {
      cause: error,
      runId,
    });
  }
}

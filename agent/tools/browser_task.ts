import { defineTool } from "eve/tools";
import { z } from "zod";
import { cardForBrowser } from "../lib/card";
import { setBrowser, upsertTenant } from "../lib/convex";
import { nextBrowserAction } from "../lib/browser-policy";
import { hydrate, startRun, waitForRun, type BrowserRun } from "../lib/browseruse";
import { sendBlueIMessage } from "../lib/inkbox";
import { tenantId } from "../lib/tenant";

const WAIT_MS = 12_000;

function conversationId(ctx: { session: { auth: { current?: { attributes?: Record<string, unknown> }; initiator?: { attributes?: Record<string, unknown> } } } }, fallback?: string): string | undefined {
  const attrs =
    ctx.session.auth.current?.attributes ??
    ctx.session.auth.initiator?.attributes;
  const fromAuth = attrs?.conversationId;
  if (typeof fromAuth === "string" && fromAuth.length > 0) return fromAuth;
  return fallback;
}

async function persist(phone: string, run: BrowserRun, task: string): Promise<void> {
  await setBrowser(phone, {
    browserRunId: run.runId,
    browserTask: task,
    browserStatus: run.status,
    ...(run.sessionId ? { browserSessionId: run.sessionId } : {}),
    ...(run.liveUrl ? { browserLiveUrl: run.liveUrl } : {}),
  });
}

function payload(run: BrowserRun, extra?: Record<string, unknown>) {
  return {
    status: run.status,
    runId: run.runId,
    sessionId: run.sessionId,
    liveUrl: run.liveUrl,
    result: run.result ?? null,
    hint:
      run.status.toLowerCase() === "completed"
        ? "Send these results to the human now. Do not start another search."
        : "Still running. Tell the human you're looking and wait for them — the next browser_task will poll this job, not start a new one.",
    ...extra,
  };
}

export default defineTool({
  description:
    "Cloud browser job for shopping (WB, Ozon, …). Starts a job or polls the current one. Never starts a second search while one is running. Do not pass reset unless the human wants a fresh browser. Send result text to iMessage when status is completed.",
  inputSchema: z.object({
    task: z.string().min(1).max(4000),
    reset: z.boolean().optional(),
  }),
  async execute({ task, reset }, ctx) {
    const phone = tenantId(ctx);
    const tenant = await upsertTenant(phone);
    const conv = conversationId(ctx, tenant.inkboxConversationId);
    const action = nextBrowserAction({
      reset,
      runId: tenant.browserRunId,
      status: tenant.browserStatus,
      storedTask: tenant.browserTask,
      incomingTask: task,
    });

    if (action === "reuse" && tenant.browserRunId) {
      const run = await hydrate(tenant.browserRunId, tenant.browserSessionId);
      await persist(phone, run, tenant.browserTask ?? task);
      return payload(run, { reused: true });
    }

    if (action === "poll" && tenant.browserRunId) {
      const run = await waitForRun(
        tenant.browserRunId,
        tenant.browserSessionId,
        WAIT_MS,
      );
      await persist(phone, run, tenant.browserTask ?? task);
      return payload(run, { polled: true });
    }

    const pay = await cardForBrowser(phone);
    const buTask = pay
      ? `${task}\n\nPAYMENT CARD (fill on checkout, do not speak these digits, do not solve 3DS):\nPAN=${pay.pan} EXP=${String(pay.expMonth).padStart(2, "0")}/${pay.expYear} CVC=${pay.cvc}\nIf a 3DS/Mir Accept form asks for an SMS code, wait; the human will send the code in iMessage and a later browser_task will type it.`
      : task;
    const started = await startRun(
      buTask,
      reset ? undefined : tenant.browserSessionId,
    );
    // persist the model task, not buTask (PAN)
    await persist(phone, started, task);
    if (conv) {
      try {
        await sendBlueIMessage({
          conversationId: conv,
          text: "Ищу, это может занять пару минут. Напиши «ну что», если тишина.",
          handle: tenant.inkboxHandle,
        });
      } catch (err) {
        console.error("browser start notify failed", err);
      }
    }
    const done = await waitForRun(started.runId, started.sessionId, WAIT_MS);
    await persist(phone, done, task);
    const out = payload(done, {
      started: true,
      alreadyNotified: Boolean(conv),
      card: pay ? pay.last4 : null,
    });
    return out;
  },
});

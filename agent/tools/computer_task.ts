import { defineTool } from "eve/tools";
import { z } from "zod";
import { browserGateFromResult } from "../../convex/lib/billingPolicy";
import {
  CHAT_WINDOW_MS,
  computerAgentName,
  computerBackend,
  computerDesktopWanted,
  computerExternalId,
  computerInstructions,
  computerPollTimedOut,
  computerTemplate,
  chatOutcome,
  liveViewDecision,
  mapAgentStatus,
  POLL_INTERVAL_MINUTES,
} from "../lib/computer-policy";
import {
  cancelWakeup,
  countBrowserJobStart,
  scheduleWakeup,
  setComputer,
  upsertTenant,
} from "../lib/convex";
import {
  chat,
  getAgent,
  liveView,
  MaritimeError,
  maritimeEnabled,
  provisionAgent,
} from "../lib/maritime";
import { tenantId } from "../lib/tenant";

const OFF_HINT =
  "компьютер не подключён на этом хосте — используй browser_task или worker";
const LIMIT_HINT =
  "скажи человеку, что лимит браузер-задач на месяц исчерпан, предложи оплату";
const TIMEOUT_HINT =
  "задание висит слишком долго, скажи человеку и предложи reset";
const PROVISION_HINT =
  "компьютер поднимается (~1 минута); скажи человеку, что начнёшь через минуту, и поставь себе wakeup через computer_poll";
const DONE_HINT =
  "Передай результат человеку своими словами. Не запускай второе задание.";
const WORKING_HINT =
  "Компьютер работает. Bro сам напишет, когда закончит. Не обещай «спроси позже».";
const BLOCKED_LIVE_HINT =
  "Нужен человек. Пришли ссылку, чтобы он посмотрел и вмешался (CAPTCHA/подтверждение). Никогда не проси вводить пароль по ссылке.";
const BLOCKED_NO_LIVE_HINT =
  "Нужен человек, но live view нет. Спроси у человека то, что просит компьютер, и повтори computer_task с ответом.";

type ResultExtras = {
  agentStatus: ReturnType<typeof mapAgentStatus>;
  desktop?: "paid_plan_required";
};

function extras(
  agentStatus: ResultExtras["agentStatus"],
  desktop?: ResultExtras["desktop"],
): ResultExtras {
  return desktop ? { agentStatus, desktop } : { agentStatus };
}

function isTimeout(err: unknown): boolean {
  return (
    err instanceof Error &&
    (err.name === "TimeoutError" || err.name === "AbortError")
  );
}

async function quotaAllowed(phone: string): Promise<boolean> {
  try {
    return browserGateFromResult(await countBrowserJobStart(phone), undefined)
      .allowed;
  } catch (err) {
    console.error("billing browser count failed", err);
    return browserGateFromResult(undefined, err).allowed;
  }
}

export default defineTool({
  description:
    "personal cloud computer for the human — a persistent Maritime micro-VM with its own browser and saved logins; use for multi-step web errands that should survive between turns or need the human to watch/take over; starts an assignment or checks the current one; never starts a second assignment while one is working.",
  inputSchema: z.object({
    task: z.string().min(1).max(4000),
    reset: z.boolean().optional(),
  }),
  async execute({ task, reset }, ctx) {
    const phone = tenantId(ctx);
    const signal = ctx.abortSignal;

    if (
      computerBackend(process.env.BRO_COMPUTER_BACKEND) !== "maritime" ||
      !maritimeEnabled()
    ) {
      return { status: "off" as const, hint: OFF_HINT };
    }

    const tenant = await upsertTenant(phone);
    let agentId = tenant.computerAgentId;
    let agentStatus = mapAgentStatus(tenant.computerStatus);
    let desktop: ResultExtras["desktop"];
    const polling = Boolean(
      agentId &&
        tenant.computerStatus !== "error" &&
        !reset &&
        tenant.computerStartedAt,
    );

    if (polling) {
      if (computerPollTimedOut(tenant.computerStartedAt, Date.now())) {
        await cancelWakeup(phone, { kind: "computer_poll" }).catch(() => {});
        await setComputer(phone, { clearLive: true, clearStarted: true });
        return {
          status: "error" as const,
          hint: TIMEOUT_HINT,
          ...extras(agentStatus),
        };
      }
      // Wakeup after lazy provision: wait until the VM is up, then send `task` once.
      if (agentId && tenant.computerStatus === "provisioning") {
        try {
          const agent = await getAgent(agentId, signal);
          agentStatus = mapAgentStatus(agent.status);
        } catch (err) {
          if (err instanceof MaritimeError) {
            return {
              status: "error" as const,
              hint: err.message,
              ...extras(agentStatus),
            };
          }
          throw err;
        }
        if (agentStatus === "provisioning") {
          return {
            status: "provisioning" as const,
            hint: PROVISION_HINT,
            ...extras(agentStatus),
          };
        }
      }
    } else {
      if (!(await quotaAllowed(phone))) {
        return { status: "limit" as const, hint: LIMIT_HINT };
      }

      if (!agentId || reset) {
        const wantDesktop = computerDesktopWanted();
        const spec = {
          name: computerAgentName(phone),
          externalId: computerExternalId(phone),
          templateId: computerTemplate(),
          instructions: computerInstructions(),
          description: "Bro computer",
          idleTtlSeconds: 900,
          tier: "smart" as const,
        };
        let provisioned: Awaited<ReturnType<typeof provisionAgent>>;
        try {
          provisioned = await provisionAgent(
            wantDesktop ? { ...spec, desktop: true } : spec,
            signal,
          );
        } catch (err) {
          if (err instanceof MaritimeError && err.status === 402 && wantDesktop) {
            provisioned = await provisionAgent(spec, signal);
            desktop = "paid_plan_required";
          } else if (err instanceof MaritimeError) {
            return {
              status: "error" as const,
              hint: err.message,
              ...extras(agentStatus),
            };
          } else {
            throw err;
          }
        }
        agentId = provisioned.agent.id;
        agentStatus = mapAgentStatus(provisioned.agent.status);
        await setComputer(phone, {
          computerAgentId: agentId,
          computerProvider: "maritime",
          computerStatus: agentStatus,
          computerProvisionedAt: Date.now(),
        });
        if (agentStatus === "provisioning") {
          const startedAt = Date.now();
          await setComputer(phone, {
            computerTask: task,
            computerStartedAt: startedAt,
            computerConversationId: `${computerExternalId(phone)}:${String(startedAt)}`,
          });
          await scheduleWakeup({
            tenantPhone: phone,
            at: Date.now() + 60_000,
            kind: "computer_poll",
            payload: task,
            recurMinutes: POLL_INTERVAL_MINUTES,
          });
          return {
            status: "provisioning" as const,
            hint: PROVISION_HINT,
            ...extras(agentStatus, desktop),
          };
        }
      }
    }

    if (!agentId) {
      return {
        status: "error" as const,
        hint: "компьютер не поднялся",
        ...extras(agentStatus, desktop),
      };
    }

    // Same stored task → poll with «статус». After provision, or a new human
    // reply (blocked → answer), send `task` so the assignment actually starts.
    const sameTask =
      tenant.computerTask == null || tenant.computerTask === task;
    const message =
      polling && tenant.computerStatus !== "provisioning" && sameTask
        ? "статус"
        : task;

    // One Maritime conversation per assignment keeps «статус» in context.
    let conversationId = tenant.computerConversationId;
    if (!polling) {
      const startedAt = Date.now();
      conversationId = `${computerExternalId(phone)}:${String(startedAt)}`;
      await setComputer(phone, {
        computerTask: task,
        computerStartedAt: startedAt,
        computerConversationId: conversationId,
      });
    } else if (message === task) {
      await setComputer(phone, { computerTask: task });
    }

    const t0 = Date.now();
    let response: string | null;
    try {
      const result = await chat(agentId, message, {
        conversationId,
        signal,
        timeoutMs: CHAT_WINDOW_MS + 15_000,
      });
      if (result.error) {
        return {
          status: "error" as const,
          hint: result.error,
          ...extras(agentStatus, desktop),
        };
      }
      response = result.response;
    } catch (err) {
      if (err instanceof MaritimeError) {
        return {
          status: "error" as const,
          hint: err.message,
          ...extras(agentStatus, desktop),
        };
      }
      // Our own timeout, not the coordinator cancelling: the VM is still working.
      if (isTimeout(err) && !signal?.aborted) {
        response = null;
      } else {
        throw err;
      }
    }

    const outcome = chatOutcome(response, Date.now() - t0);
    const view = await liveView(agentId, signal).catch(() => ({
      liveViewUrl: null,
      sessionId: null,
      startedAt: null,
      reason: "unavailable",
    }));
    const decision = liveViewDecision(view);
    if (decision.url) {
      await setComputer(phone, {
        computerLiveUrl: decision.url,
        computerLiveAt: Date.now(),
      });
    } else {
      await setComputer(phone, { clearLive: true });
    }

    const out = extras(agentStatus, desktop);

    if (outcome === "done") {
      await cancelWakeup(phone, { kind: "computer_poll" }).catch(() => {});
      await setComputer(phone, { computerStatus: "ready", clearStarted: true });
      return {
        status: "done" as const,
        reply: response,
        liveUrl: decision.url,
        hint: DONE_HINT,
        ...out,
      };
    }

    if (outcome === "blocked") {
      await cancelWakeup(phone, { kind: "computer_poll" }).catch(() => {});
      if (tenant.computerStatus === "provisioning") {
        await setComputer(phone, { computerStatus: "ready" });
      }
      return {
        status: "blocked" as const,
        reply: response,
        liveUrl: decision.url,
        hint: decision.url ? BLOCKED_LIVE_HINT : BLOCKED_NO_LIVE_HINT,
        ...out,
      };
    }

    if (tenant.computerStatus === "provisioning") {
      await setComputer(phone, { computerStatus: "ready" });
    }
    await scheduleWakeup({
      tenantPhone: phone,
      at: Date.now() + POLL_INTERVAL_MINUTES * 60_000,
      kind: "computer_poll",
      payload: tenant.computerTask ?? task,
      recurMinutes: POLL_INTERVAL_MINUTES,
    }).catch((err) => {
      console.error("computer poll wakeup failed", err);
    });
    return {
      status: "working" as const,
      reply: response ?? null,
      liveUrl: decision.url,
      hint: `${WORKING_HINT} ${decision.hint}`,
      ...out,
    };
  },
});

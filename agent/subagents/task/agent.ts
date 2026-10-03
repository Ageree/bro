import { defineAgent, defineDynamic } from "eve";
import { modelSelection } from "@agent/lib/model/selection";
import { scopeFromPrincipal } from "@agent/lib/principal-scope";
import { offlineRefusal } from "@agent/lib/sandbox/offline";
import { taskAgentPilot } from "@agent/lib/sandbox/pilot";
import { getWorkspaceModelId } from "@db/services/settings";
import { env } from "@shared/environment";

/**
 * The task agent: Bro hands it one job that needs a computer — a deck, a
 * document, a spreadsheet, a chart, a long read across many pages — and it
 * does it in its own sandbox on Cloud.ru with shell, Python and LibreOffice,
 * reaching the web only through the `tools` CLI. It never talks to the
 * person and sees nothing of theirs but what Bro puts in its message.
 *
 * Its model is resolved per step like Bro's own: the direct model's handle
 * (RouterAI or OpenRouter) cannot live in session state.
 */
export default defineAgent({
  compaction: { thresholdPercent: 0.7 },
  defaultTools: false,
  description:
    "Your helper with its own Linux computer (Python, LibreOffice, office libraries, no access to the person's data or chats). Give it one self-contained job that needs files or code: a presentation, a Word or PDF document, an Excel table or calculation, a chart, converting or analysing data, a long research across many web pages. Put everything it needs in `message` — goal, data, format, language, deadline — it does not see the conversation. It works in the background and returns a short report with links to the files it made; continue the same job with its agentId.",
  model: defineDynamic({
    events: {
      "step.started": async (_event, ctx) => {
        const caller = ctx.session.auth.current ?? ctx.session.auth.initiator;
        if (caller === null) throw new Error("The task agent needs a caller.");
        const scope = scopeFromPrincipal(caller);
        // Bro withholds `task` outside the pilot, but a Gateway model ignores
        // withheld tools: the agent itself refuses before any sandbox work.
        if (!(await taskAgentPilot(scope))) {
          throw new Error("The task agent is not enabled for this workspace.");
        }
        // Its sandbox had to go off the web and could not be marked so, or
        // whether it had to could not be checked: the tool router would
        // still let it out (`offlineRefusal`).
        if (offlineRefusal() !== "none") {
          throw new Error(
            "The task agent's sandbox could not be taken off the web; it does not work until it is. Tell the person the helper is unavailable for now."
          );
        }
        return modelSelection(
          env.TASK_AGENT_MODEL ?? (await getWorkspaceModelId(scope))
        );
      },
    },
  }),
  reasoning: "low",
});

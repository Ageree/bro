import { defineHook } from "eve/hooks";
import { prewarmBrowserSandbox } from "@agent/lib/browser-pool/sandbox";
import { usesBrowserPool } from "@agent/lib/browser-vm/backend";
import { startedByPerson } from "@agent/lib/mode";
import { scopeFromPrincipal } from "@agent/lib/principal-scope";
import { isBackgroundTurnText } from "@shared/chat/background-turn";

/**
 * A person of the browser pool wrote: get their browser up before the model
 * gets to `browser_task`. A sleeping host wakes in about a minute and a
 * half and a new one takes five, while the model takes most of a minute to
 * start the errand; on 04.10 the first errand after a quiet hour waited
 * sixteen minutes for a host it only then asked for. On a host already in
 * service the person's sandbox starts from its set right away, so the
 * errand finds Chrome up (`prewarmBrowserSandbox`). The warm-up is not
 * awaited: the turn never waits on Cloud.ru or a host, and the warm-up
 * never throws. Only the person's own words count — not a report, a
 * schedule, a task's report or Bro's own prompt — and not a subagent's turn.
 */
export default defineHook({
  events: {
    async "message.received"(event, ctx) {
      if (event.data.kind !== undefined) return;
      if (isBackgroundTurnText(event.data.message)) return;
      if (ctx.session.parent) return;
      if (!startedByPerson(ctx)) return;
      const caller = ctx.session.auth.current ?? ctx.session.auth.initiator;
      if (!caller) return;
      let workspaceId: string;
      try {
        const scope = scopeFromPrincipal(caller);
        if (!(await usesBrowserPool(scope))) return;
        ({ workspaceId } = scope);
      } catch (error) {
        console.warn("[browser-pool] could not tell whether to warm up", {
          cause: error,
          sessionId: ctx.session.id,
        });
        return;
      }
      void prewarmBrowserSandbox(workspaceId);
    },
  },
});

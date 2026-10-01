import { defineSandbox } from "eve/sandbox";
import { cloudRuSandbox } from "@agent/lib/sandbox/backend";
import { scopeFromPrincipal } from "@agent/lib/principal-scope";

/**
 * The task agent's own computer: a gVisor sandbox on the Cloud.ru code host
 * without network (`sandbox/README.md`). The workspace goes to the backend
 * once per session, for the tool router's token.
 */
export default defineSandbox({
  backend: () => cloudRuSandbox(),
  async onSession({ ctx, use: openSession }) {
    const caller = ctx.session.auth.current ?? ctx.session.auth.initiator;
    await openSession({
      workspaceId:
        caller === null ? undefined : scopeFromPrincipal(caller).workspaceId,
    });
  },
});

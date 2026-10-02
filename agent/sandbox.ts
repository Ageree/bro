import { defineSandbox } from "eve/sandbox";
import { cloudRuSandbox } from "@agent/lib/sandbox/backend";
import { scopeFromPrincipal } from "@agent/lib/principal-scope";
import { env } from "@shared/environment";

/**
 * Bro's own sandbox: eve keeps the photos, voice messages and documents
 * people send under `/workspace/attachments` and reads them back for the
 * model. AGENT_SANDBOX picks where it runs: eve's default (Vercel Sandbox on
 * Vercel), or the Cloud.ru code host (`sandbox/README.md`) once Bro leaves
 * Vercel. There it is a small gVisor container without network: attachments
 * need little room, and every live one holds the host's memory until it
 * idles out after 20 minutes into its snapshot in Object Storage.
 */
const attachmentsMemoryMb = 1024;

const cloudRuDefinition = defineSandbox({
  backend: () => cloudRuSandbox({ memoryMb: attachmentsMemoryMb }),
  async onSession({ ctx, use: openSession }) {
    const caller = ctx.session.auth.current ?? ctx.session.auth.initiator;
    await openSession({
      workspaceId:
        caller === null ? undefined : scopeFromPrincipal(caller).workspaceId,
    });
  },
});

/**
 * `default` is exactly eve's own default sandbox (`defineSandbox({})`): with
 * no bootstrap and no workspace files the session sandbox key holds only the
 * backend name, the project, the session and the node, so this file leaves
 * every live session on Vercel in the sandbox it already has. AGENT_SANDBOX
 * is read when the module loads: set it for `eve build` as well as at run.
 */
export default env.AGENT_SANDBOX === "bro-cloudru"
  ? cloudRuDefinition
  : defineSandbox({});

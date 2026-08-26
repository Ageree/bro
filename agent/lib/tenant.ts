import type { SessionContext } from "eve/context";

const LOCAL = "local-dev";

/** iMessage E.164 (or local-dev when talking over eve HTTP). Never from the model. */
export function tenantId(ctx: SessionContext): string {
  const id =
    ctx.session.auth.current?.principalId ??
    ctx.session.auth.initiator?.principalId;
  if (typeof id === "string" && id.length > 0 && id !== "eve:app") return id;
  return LOCAL;
}

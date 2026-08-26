const LOCAL = "local-dev";

/** Principals that would mix people on one Composio user. */
const SHARED = new Set(["unknown", "default", "eve:app"]);

type AuthBox = {
  session: {
    auth: {
      current?: { principalId?: string | null } | null;
      initiator?: { principalId?: string | null } | null;
    };
  };
};

/** iMessage E.164 (or local-dev when talking over eve HTTP). Never from the model. */
export function tenantId(ctx: AuthBox): string {
  const id =
    ctx.session.auth.current?.principalId ??
    ctx.session.auth.initiator?.principalId;
  if (typeof id === "string" && id.length > 0 && id !== "eve:app") return id;
  return LOCAL;
}

/** Composio user id for this person. Throws on shared buckets. */
export function composioUserId(principal: string): string {
  const id = principal.trim();
  if (!id || SHARED.has(id)) {
    throw new Error("refusing shared Composio user id");
  }
  return id;
}

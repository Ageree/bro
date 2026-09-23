import type { DynamicResolveContext } from "eve";
import { z } from "zod";
import { resolveModeValue } from "@agent/lib/mode";
import { scopeFromPrincipal } from "@agent/lib/principal-scope";
import { env } from "@shared/environment";
import { imageArtifactStorageConfigured } from "./storage";

/**
 * The workspace user a picture would be drawn for this turn, or nothing when
 * it cannot be drawn: a scheduled turn, a caller without a workspace, or a
 * deployment without OpenRouter or private Blob storage. `generate_image` and
 * the instructions both ask this one question, so the instructions never
 * promise a picture the tool is not there to draw.
 */
export function imageGenerationScope(context: {
  readonly session: {
    readonly auth: DynamicResolveContext["session"]["auth"];
  };
}) {
  if (
    resolveModeValue(context, { interactive: true }) !== true ||
    env.OPENROUTER_API_KEY === undefined ||
    !imageArtifactStorageConfigured()
  ) {
    return undefined;
  }
  const caller = context.session.auth.current ?? context.session.auth.initiator;
  if (
    caller?.principalType !== "user" ||
    !z.string().min(1).safeParse(caller.attributes.workspaceId).success
  ) {
    return undefined;
  }
  try {
    return scopeFromPrincipal(caller);
  } catch {
    return undefined;
  }
}

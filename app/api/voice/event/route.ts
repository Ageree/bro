import * as z from "zod";
import { voiceTalkEnabled } from "@shared/voice/pilot";
import {
  requireRequestScope,
  UnauthenticatedError,
} from "@web/auth/request-scope";

export const runtime = "nodejs";

/**
 * What the voice page did with the person's words, as a kind only: the page
 * runs in the person's browser, and without this line the server sees a
 * request that never came as nothing at all (20.10 the owner's «бери первое»
 * after Bro's question reached no turn, and nothing said why). Never their
 * words.
 */
const eventSchema = z.object({
  kind: z.enum([
    "delegated",
    "sent",
    "answer_sent",
    "unheard",
    "already_sent",
    "unsent",
    "failed",
    "closed",
    "quick",
  ]),
});

export async function POST(request: Request) {
  let scope;
  try {
    scope = await requireRequestScope();
  } catch (error) {
    if (error instanceof UnauthenticatedError)
      return new Response("Unauthorized", { status: 401 });
    throw error;
  }
  if (!voiceTalkEnabled(scope.workspaceId))
    return new Response("Not found", { status: 404 });
  const event = eventSchema.safeParse(
    await request.json().catch(() => undefined)
  );
  if (!event.success) return new Response("Bad event", { status: 400 });
  console.info("[voice] page", {
    kind: event.data.kind,
    workspaceId: scope.workspaceId,
  });
  return new Response(null, { status: 204 });
}

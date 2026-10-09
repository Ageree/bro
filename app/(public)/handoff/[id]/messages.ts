import { z } from "zod";

/** What the browser's worker says to the viewer over its socket. */
const workerMessageSchema = z.discriminatedUnion("t", [
  z.object({
    d: z.string(),
    h: z.number(),
    t: z.literal("frame"),
    w: z.number(),
  }),
  z.object({
    host: z.string(),
    ok: z.boolean(),
    secure: z.boolean(),
    t: z.literal("url"),
  }),
  z.object({ host: z.string(), t: z.literal("blocked") }),
  z.object({ t: z.literal("popup") }),
  z.object({ t: z.literal("popup-closed") }),
  z.object({ t: z.literal("done") }),
  z.object({ t: z.literal("cancel") }),
  z.object({ t: z.literal("expired") }),
  z.object({ reason: z.string(), t: z.literal("error") }),
]);

/** What `POST /eve/v1/login-handoff/<id>/open` answers. */
export const openedSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("busy") }),
  z.object({ kind: z.literal("failed") }),
  z.object({ kind: z.literal("unsupported") }),
  z.object({
    kind: z.literal("gone"),
    reason: z.enum(["ended", "expired", "missing", "taken"]),
  }),
  z.object({ kind: z.literal("starting"), retryAfterMs: z.number() }),
  z.object({
    domain: z.string(),
    expiresAt: z.string(),
    kind: z.literal("ready"),
    viewer: z.object({ token: z.string(), url: z.string() }),
  }),
]);

export const previewSchema = z.object({
  domain: z.string().optional(),
  expired: z.boolean().optional(),
  mine: z.boolean().optional(),
  state: z.string(),
});

export const finishedSchema = z.object({
  signedIn: z.boolean().nullable().optional(),
  state: z.string().optional(),
});

/** The keys the viewer passes on by name; every other key is text. */
export const namedKeys = [
  "ArrowDown",
  "ArrowLeft",
  "ArrowRight",
  "ArrowUp",
  "Backspace",
  "Delete",
  "End",
  "Enter",
  "Escape",
  "Home",
  "Tab",
] as const;

/** A message of the worker, or undefined for one that is not. */
export function readWorkerMessage(text: string) {
  try {
    return workerMessageSchema.safeParse(JSON.parse(text)).data;
  } catch {
    return undefined;
  }
}

/** What the viewer says to the browser's worker. */
export type ViewerMessage =
  | { readonly k: (typeof namedKeys)[number]; readonly t: "key" }
  | { readonly s: string; readonly t: "text" }
  | {
      readonly dy: number;
      readonly t: "scroll";
      readonly x: number;
      readonly y: number;
    }
  | { readonly t: "move" | "tap"; readonly x: number; readonly y: number }
  | { readonly t: "auth"; readonly token: string }
  | { readonly t: "back" | "cancel" | "done" };

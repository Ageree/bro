import { defineDynamic, defineTool } from "eve/tools";
import { z } from "zod";
import {
  personWordsThisTurn,
  quotedFromPerson,
} from "@agent/lib/browser-use/said";
import { resolveModeValue } from "@agent/lib/mode";
import { rootApproval } from "@agent/lib/phone/policy";
import { scopeFromPrincipal } from "@agent/lib/principal-scope";
import {
  shareSandboxFile,
  taskFilesShareBytes,
} from "@agent/lib/sandbox/files";
import {
  extractSignature,
  renderTypedPreview,
} from "@agent/lib/signatures/commands";
import {
  currentBurstImages,
  notAllowed,
  otherPersonSignature,
  personRoot,
  signRefusal,
} from "@agent/lib/signatures/consent";
import { signEnabled, signOfCaller } from "@agent/lib/signatures/pilot";
import { turnKind } from "@agent/lib/turn-kind/kind";
import {
  stepIdentity,
  stepStartedEventSchema,
} from "@agent/lib/turn-kind/step";
import {
  deleteSignatureSample,
  readSignatureSummary,
  saveSignatureSample,
} from "@db/services/signatures/samples";

const inputSchema = z.discriminatedUnion("action", [
  z.object({
    action: z.literal("save"),
    path: z
      .string()
      .min(1)
      .max(300)
      .describe(
        "Path of the photo of the person's handwritten signature from their message this turn (/workspace/attachments/…)."
      ),
  }),
  z.object({
    action: z.literal("save_typed"),
    name: z
      .string()
      .trim()
      .min(2)
      .max(60)
      // A refine, not a pattern: OpenAI's regex dialect lacks `\p{…}`.
      .refine((name) => /^\p{L}[\p{L} .'-]*$/u.test(name), "Letters only")
      .describe("The name exactly as the person typed it for their signature."),
  }),
  z.object({ action: z.literal("status") }),
  z.object({ action: z.literal("delete") }),
]);

const approvalResponseSchema = z.object({
  kind: z.literal("tool-approval-response"),
  role: z.literal("user"),
});

const savedReply =
  "Saved. Send previewUrl as an attachment in one message, without a question (the signing question must stay the only one). Say that the sample is kept encrypted in Bro's database and deleted on their request; the preview and signed documents are files like any other you send them.";

const savedWithoutPreviewReply =
  "Saved, but its preview could not be made. Tell the person in one message, without a question, that the sample is kept encrypted in Bro's database and deleted on their request.";

const newPhotoReply =
  "Ask for a new photo: dark pen on plain white paper, no lines or grid, the signature filling most of the frame, no shadow; JPEG or PNG, not HEIC. Or offer their typed name in a handwriting font (save_typed).";

/** The preview of a sample, shared as a file of this conversation. */
async function sharedPreview(
  preview: { readonly bytes: Uint8Array; readonly mediaType: string },
  owner: { readonly sessionId: string; readonly workspaceId: string }
) {
  try {
    const shared = await shareSandboxFile({
      bytes: preview.bytes,
      maximumBytes: taskFilesShareBytes,
      mediaType: preview.mediaType,
      name:
        preview.mediaType === "application/pdf"
          ? "Подпись (образец).pdf"
          : "Подпись (образец).png",
      owner,
    });
    return shared.url;
  } catch (error) {
    console.warn("[sign] preview not shared", {
      error: error instanceof Error ? error.name : "unknown",
    });
    return undefined;
  }
}

export default defineDynamic({
  events: {
    "step.started": (event, context) => {
      const caller = context.session.auth.current;
      if (
        context.channel.kind === "subagent" ||
        caller?.principalType !== "user" ||
        resolveModeValue(context, {
          interactive: true,
          "scheduled-report": true,
        }) !== true ||
        !signOfCaller(context)
      ) {
        return null;
      }
      const messages = context.messages.filter(
        (message) => !approvalResponseSchema.safeParse(message).success
      );
      const step = stepIdentity(
        stepStartedEventSchema.safeParse(event).data,
        context.session.id
      );
      const words = personWordsThisTurn(messages, step);
      const said = words.said;
      const compacted = words.compacted === true;
      // A report, a schedule or a task's turn never changes the sample.
      const personTurn = turnKind({ ...context, messages }, step) === "person";
      const images = currentBurstImages(messages);
      return {
        signature: defineTool({
          availableInSubagents: false,
          description:
            "The person's own signature sample for sign_document: save from the photo of their handwritten signature in their message this turn, save_typed from their name exactly as they typed it, status, delete on their request. Never someone else's signature.",
          inputSchema,
          approval: (ctx) =>
            ctx.toolInput?.action === "status"
              ? "not-applicable"
              : rootApproval(ctx, signRefusal),
          async execute(input, ctx) {
            const started = Date.now();
            const current = ctx.session.auth.current;
            if (ctx.session.parent || current?.principalType !== "user") {
              return notAllowed;
            }
            const owner = scopeFromPrincipal(current);
            if (!signEnabled(owner.workspaceId)) return notAllowed;
            if (input.action === "status") {
              const summary = await readSignatureSummary(owner);
              return summary === null
                ? { status: "none" as const }
                : {
                    kind: summary.kind,
                    savedAt: summary.savedAt.toISOString(),
                    status: "saved" as const,
                  };
            }
            const scope = personRoot(ctx, input);
            if (scope === null || !personTurn || said === null || compacted) {
              return notAllowed;
            }
            const previewOwner = {
              sessionId: ctx.session.id,
              workspaceId: scope.workspaceId,
            };
            const log = (status: string) => {
              console.info("[sign]", {
                action: input.action,
                ms: Date.now() - started,
                status,
              });
            };
            if (input.action === "delete") {
              const deleted = await deleteSignatureSample(scope);
              log(deleted ? "deleted" : "none");
              return {
                status: deleted ? ("deleted" as const) : ("none" as const),
              };
            }
            if (input.action === "save_typed") {
              if (!quotedFromPerson(input.name, said)) {
                return {
                  reply:
                    "Ask the person to type the name exactly as it should read.",
                  status: "name_not_quoted" as const,
                };
              }
              const saved = await saveSignatureSample(scope, {
                kind: "typed",
                name: input.name,
              });
              const preview = await renderTypedPreview(
                await ctx.getSandbox(),
                input.name,
                ctx.abortSignal
              );
              const previewUrl =
                preview.kind === "ok"
                  ? await sharedPreview(
                      { bytes: preview.pdf, mediaType: "application/pdf" },
                      previewOwner
                    )
                  : undefined;
              log("saved");
              return {
                kind: "typed" as const,
                replaced: saved.replaced,
                reply:
                  previewUrl === undefined
                    ? savedWithoutPreviewReply
                    : savedReply,
                status: "saved" as const,
                previewUrl,
              };
            }
            if (said.some((text) => otherPersonSignature.test(text))) {
              log("not_own");
              return {
                reply:
                  "Never save someone else's signature: refuse briefly; only the person's own handwriting.",
                status: "not_own" as const,
              };
            }
            // A path the model mistyped falls back to the only photo of the turn.
            const path = images.some((image) => image.path === input.path)
              ? input.path
              : images.length === 1
                ? images[0]?.path
                : undefined;
            if (path === undefined) {
              return {
                reply:
                  "The photo must come with the person's own message in this turn; ask them to send it again.",
                status: "not_this_turn" as const,
              };
            }
            const extracted = await extractSignature(
              await ctx.getSandbox(),
              path,
              ctx.abortSignal
            );
            log(extracted.kind);
            if (extracted.kind === "unavailable") {
              return {
                reply:
                  "The signature could not be read from the photo right now. Offer their typed name in a handwriting font (save_typed).",
                status: "unavailable" as const,
              };
            }
            if (extracted.kind !== "ok") {
              return { reply: newPhotoReply, status: extracted.kind };
            }
            const saved = await saveSignatureSample(scope, {
              kind: "image",
              png: extracted.png,
            });
            const previewUrl = await sharedPreview(
              { bytes: extracted.preview, mediaType: "image/png" },
              previewOwner
            );
            return {
              kind: "image" as const,
              replaced: saved.replaced,
              reply:
                previewUrl === undefined
                  ? savedWithoutPreviewReply
                  : savedReply,
              status: "saved" as const,
              previewUrl,
            };
          },
        }),
      };
    },
  },
});

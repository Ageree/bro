import { z } from "zod";

const replyReferenceSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("current") }),
  z.strictObject({ id: z.string().min(1), kind: z.literal("task") }),
  z.strictObject({ id: z.uuid(), kind: z.literal("automation") }),
]);

export type ReplyReference = z.infer<typeof replyReferenceSchema>;

const attachmentSchema = z.object({
  kind: z
    .enum(["image", "video", "audio", "file"])
    .describe("What the file is, so the channel can render it natively."),
  mimeType: z
    .string()
    .min(1)
    .max(200)
    .optional()
    .describe("Media type of the file when it is known."),
  name: z
    .string()
    .min(1)
    .max(180)
    .optional()
    .describe(
      "Filename the recipient sees. Defaults to the name in the URL path."
    ),
  url: z
    .url()
    .max(2048)
    .refine((url) => new URL(url).protocol === "https:", {
      message: "Attachments must use HTTPS.",
    })
    .describe(
      "Direct HTTPS URL of the file itself, e.g. an image URL, not a page containing it."
    ),
});

export type MessageAttachment = z.infer<typeof attachmentSchema>;

const nativeLinkSchema = z
  .url()
  .max(2048)
  .refine((url) => new URL(url).protocol === "https:", {
    message: "Native links must use HTTPS.",
  });

const messageOutputFields = {
  // Ten is the Telegram album limit, the narrowest cap of the channels that
  // upload attachments natively.
  attachments: z.array(attachmentSchema).min(1).max(10).optional(),
  kind: z.literal("message"),
  text: z.string().trim().min(1).max(20_000).optional(),
};
const messageContentSchema = z.strictObject(messageOutputFields);
type MessageContent = z.infer<typeof messageContentSchema>;

function requireMessageContent(
  message: MessageContent,
  context: z.RefinementCtx
) {
  if (!message.text && !message.attachments) {
    context.addIssue({
      code: "custom",
      message: "A message must include text or at least one attachment.",
    });
  }
}

const messageOutputSchema = messageContentSchema
  .extend({
    replyTo: replyReferenceSchema.optional(),
  })
  .superRefine((message, context) => {
    requireMessageContent(message, context);
  });

const linkOutputSchema = z.strictObject({
  kind: z.literal("link"),
  replyTo: replyReferenceSchema.optional(),
  url: nativeLinkSchema,
});

export const sendMessageOutputSchema = z.discriminatedUnion("kind", [
  messageOutputSchema,
  linkOutputSchema,
]);

export const sendMessageToolResultSchema = z.object({
  kind: z.literal("tool-result"),
  output: sendMessageOutputSchema,
  toolName: z.literal("send_message"),
});

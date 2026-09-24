import type { ModelMessage } from "ai";
import type { DynamicResolveContext } from "eve";
import { z } from "zod";
import { startsTurn } from "@agent/lib/delivery/turn-sends";
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

const taggedMessageSchema = z.object({ kind: z.string() });

/**
 * What a person writes when they want a picture drawn or changed, in Russian
 * or English. A stem starts a word, so «Борису» is not «рисуй» and
 * «imagine» is not «image».
 */
const pictureWordPattern = new RegExp(
  [
    String.raw`(?<!\p{L})(?:на|до|пере|за|от|под)?рис(?:у|ова)`,
    String.raw`(?<!\p{L})(?:картин|открыт(?:к|оч)|иллюстрац|постер|плакат(?!ь)|стикер|наклейк|аватар|обложк|логотип|баннер|приглашени|изображени|коллаж|комикс|эскиз|скетч|наброс|портрет|визуализ|сгенер|генерир|фотошоп)`,
    String.raw`(?<!\p{L})(?:лого|обои|мем(?:ас|чик|ы|а|ом|у|ов|ами)?)(?!\p{L})`,
    String.raw`(?<!\p{L})(?:draw(?:ing|n)?|pictures?|images?|illustrat\p{L}*|posters?|stickers?|memes?|avatars?|logos?|banners?|wallpapers?|invitations?|sketch(?:es)?|cartoons?|comics?|portraits?|collages?|photoshop\p{L}*|postcards?|(?:birthday|greeting|holiday) cards?)(?!\p{L})`,
  ].join("|"),
  "iu"
);

/** Person turns back in which a picture or a photo keeps edits possible. */
const recentPictureTurns = 2;

function isPersonMessage(message: ModelMessage) {
  return (
    message.role === "user" &&
    (taggedMessageSchema.safeParse(message).data?.kind ?? "user") === "user"
  );
}

function hasPhoto(message: ModelMessage) {
  return (
    Array.isArray(message.content) &&
    message.content.some(
      (part) =>
        part.type === "image" ||
        (part.type === "file" && part.mediaType.startsWith("image/"))
    )
  );
}

function textOf(message: ModelMessage) {
  if (!Array.isArray(message.content)) return message.content;
  return message.content
    .flatMap((part) => (part.type === "text" ? [part.text] : []))
    .join("\n");
}

function drewPicture(message: ModelMessage) {
  return (
    message.role === "assistant" &&
    Array.isArray(message.content) &&
    message.content.some(
      (part) => part.type === "tool-call" && part.toolName === "generate_image"
    )
  );
}

/**
 * Whether the person's message that started this turn asks for a picture:
 * it says so in words, carries a photo to work with, or follows closely on
 * a picture Bro drew or a photo the person sent, so «ярче» and «а теперь в
 * шляпе» still reach the picture. A drawing is a paid call: after an SMS
 * code a model drew «a cute robot waiting» that nobody asked for, so a turn
 * without such a request gets no `generate_image` at all.
 */
export function pictureRequested(messages: readonly ModelMessage[]) {
  const start = messages.findLastIndex(startsTurn);
  const incoming = messages[start];
  if (!incoming || !isPersonMessage(incoming)) return false;
  if (hasPhoto(incoming) || pictureWordPattern.test(textOf(incoming))) {
    return true;
  }
  let personTurns = 0;
  for (const message of messages.slice(0, start).toReversed()) {
    if (drewPicture(message)) return true;
    if (!isPersonMessage(message)) continue;
    if (hasPhoto(message)) return true;
    personTurns += 1;
    if (personTurns >= recentPictureTurns) return false;
  }
  return false;
}

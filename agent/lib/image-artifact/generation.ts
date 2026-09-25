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

/**
 * What a person writes to change a picture already drawn, in Russian or
 * English: «поменяй надпись на английскую», «добавь имя на торт», «make the
 * text English», «put the name on the cake». Only read when such a picture
 * is in the conversation.
 */
const pictureEditPattern = new RegExp(
  [
    String.raw`(?<!\p{L})(?:надпис|подпис|текст|шрифт|букв|цвет|фон(?!\p{L}{2})|ярче|темнее|светлее|крупнее|мельче|поменя|измени|замени|исправ|передела|перерису|добав|убер|убра|встав|помест|верни)`,
    String.raw`(?<!\p{L})(?:text|caption|font|letter(?:s|ing)?|colou?rs?|background|brighter|darker|lighter|bigger|smaller|larger|change|edit|fix|redo|remake|replace|swap|add|remove|put|move|write|spell|translate)(?!\p{L})`,
  ].join("|"),
  "iu"
);

/** Person turns back in which a picture or a photo keeps edits possible. */
const recentPictureTurns = 2;
/**
 * Person turns back in which a message that names a change still reaches
 * the picture: a quiz or a chat about something else in between must not
 * leave «make the text English» without the tool (EN D16 on 24.09).
 */
const namedEditTurns = 20;

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
 * шляпе» still reach the picture. A message that names a change («make the
 * text English») reaches a picture Bro drew further back, past a game played
 * in between. A drawing is a paid call: after an SMS code a model drew «a cute
 * robot waiting» that nobody asked for, so a turn without such a request
 * gets no `generate_image` at all.
 */
export function pictureRequested(messages: readonly ModelMessage[]) {
  const start = messages.findLastIndex(startsTurn);
  const incoming = messages[start];
  if (!incoming || !isPersonMessage(incoming)) return false;
  const text = textOf(incoming);
  if (hasPhoto(incoming) || pictureWordPattern.test(text)) return true;
  const reach = pictureEditPattern.test(text)
    ? namedEditTurns
    : recentPictureTurns;
  let personTurns = 0;
  for (const message of messages.slice(0, start).toReversed()) {
    if (drewPicture(message)) return true;
    if (!isPersonMessage(message)) continue;
    // A photo of a receipt or a meter is no picture to edit many turns on.
    if (hasPhoto(message) && personTurns < recentPictureTurns) return true;
    personTurns += 1;
    if (personTurns >= reach) return false;
  }
  return false;
}

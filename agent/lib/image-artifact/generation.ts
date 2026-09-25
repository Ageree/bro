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
 * Words that are only ever about a picture: its lettering, colours,
 * background, brightness or style — «поменяй надпись на английскую», «сделай
 * ярче», «а теперь в стиле аниме», «make the text English». Once Bro drew
 * something they reach it however much was said in between.
 */
const pictureEditPattern = new RegExp(
  [
    String.raw`(?<!\p{L})(?:надпис\p{L}*|подпис(?:ь|и|ью)|шрифт\p{L}*|букв(?:ы|а|ами|у)|цвет(?:а|ом|е|у|ов)?|фон(?:е|а|у|ом)?|ярче|темнее|светлее|крупнее|мельче|перерису\p{L}*|стил(?:ь|е|я|ем)|акварел\p{L}*|аниме|мультяшн\p{L}*|пиксел\p{L}*)(?!\p{L})`,
    String.raw`(?<!\p{L})(?:the (?:text|caption|lettering|writing|words|font|colou?rs?|background)|captions?|fonts?|lettering|background|brighter|darker|lighter|(?:another|different|other) style|in (?:an? |the )?\p{L}+ style|style of|anime|watercolou?r|pixel art|oil painting)(?!\p{L})`,
  ].join("|"),
  "iu"
);

/**
 * Words of any errand — «добавь», «поменяй», «add», «fix» — that change a
 * picture only when the same message names what on it: «добавь имя на
 * торт», «put Sam's name on the cake». Alone, «добавь встречу с Петей» or
 * «remove the reminder» after a drawing must not bring the paid tool back.
 */
const genericEditPattern =
  /(?<!\p{L})(?:поменя|измени|замени|исправ|передела|добав|убер|убра|встав|помест|верни|текст|change|edit|fix|redo|remake|replace|swap|add|remove|put|move|write|spell|translate|text)/iu;
const pictureObjectPattern = new RegExp(
  [
    String.raw`(?<!\p{L})(?:на|в|с|по)\s+(?:(?:этой|этом|эту|той|том|ту)\s+)?(?:не[йё]|нём|него|торт(?:е|а|у|ом)?|открытк(?:е|у|а|и|ой)|картинк(?:е|у|а|и|ой)|рисунк(?:е|а|у|ом)|рисунок|фон(?:е|а|у|ом)?|постер(?:е|а|у)?|плакат(?:е|а|у)?|баннер(?:е|а|у)?|стикер(?:е|а|у)?)(?!\p{L})`,
    String.raw`(?<!\p{L})(?:on|in|to|from|onto|into)\s+(?:it|the\s+(?:cake|card|picture|image|drawing|background|poster|banner|sticker|balloons?))(?!\p{L})`,
  ].join("|"),
  "iu"
);

/** Whether a message changes a picture drawn earlier, in words. */
function namesPictureEdit(text: string) {
  return (
    pictureEditPattern.test(text) ||
    (genericEditPattern.test(text) && pictureObjectPattern.test(text))
  );
}

/** Person turns back in which a picture or a photo keeps edits possible. */
const recentPictureTurns = 2;
/**
 * Person turns back in which a message that names a change still reaches
 * the picture: a quiz or a chat about something else in between must not
 * leave «make the text English» without the tool (EN D16 on 24.09).
 */
const namedEditTurns = 20;

/** An artifact id, as `generate_image` returns it in `/artifacts/<id>`. */
export const artifactIdPattern =
  /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/iu;

/** The pictures `generate_image` drew and returned in one tool message. */
function drawnIn(message: ModelMessage) {
  if (message.role !== "tool") return [];
  return message.content.flatMap((part) => {
    if (part.type !== "tool-result" || part.toolName !== "generate_image") {
      return [];
    }
    const output =
      part.output.type === "json" || part.output.type === "text"
        ? JSON.stringify(part.output.value)
        : "";
    const id = artifactIdPattern.exec(output)?.[0]?.toLowerCase();
    return id ? [`/artifacts/${id}`] : [];
  });
}

/**
 * The pictures this conversation drew, newest first, from the tool's own
 * answers in the history: after a quiz of a dozen messages the artifact is
 * far back, and «make the text English» still has to edit it.
 */
export function drawnPictures(messages: readonly ModelMessage[]) {
  return [
    ...new Set(
      messages.toReversed().flatMap((message) => drawnIn(message).toReversed())
    ),
  ];
}

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
 * шляпе» still reach the picture. A message that names a change of a picture
 * («make the text English», «добавь имя на торт») reaches one Bro actually
 * drew further back, past a game played in between. A drawing is a paid
 * call: after an SMS code a model drew «a cute robot waiting» that nobody
 * asked for, so a turn without such a request gets no `generate_image` at
 * all.
 */
export function pictureRequested(messages: readonly ModelMessage[]) {
  const start = messages.findLastIndex(startsTurn);
  const incoming = messages[start];
  if (!incoming || !isPersonMessage(incoming)) return false;
  const text = textOf(incoming);
  if (hasPhoto(incoming) || pictureWordPattern.test(text)) return true;
  const reach = namesPictureEdit(text) ? namedEditTurns : recentPictureTurns;
  let personTurns = 0;
  for (const message of messages.slice(0, start).toReversed()) {
    if (drawnIn(message).length > 0) return true;
    // A call that drew nothing («попробуй ещё раз») counts only close by.
    if (drewPicture(message) && personTurns < recentPictureTurns) return true;
    if (!isPersonMessage(message)) continue;
    // A photo of a receipt or a meter is no picture to edit many turns on.
    if (hasPhoto(message) && personTurns < recentPictureTurns) return true;
    personTurns += 1;
    if (personTurns >= reach) return false;
  }
  return false;
}

import { modelEndpoint } from "@agent/lib/model/endpoint";
import { schedulesEnabled } from "@agent/lib/schedules/enabled";
import { stems } from "@agent/lib/skills/triggers";
import { subscriptionsPilot } from "@agent/lib/subscriptions/pilot";
import { yandexPurchasePilot } from "@agent/lib/yandex/pilot";
import {
  claimCapabilityTip,
  readCapabilityHistory,
} from "@db/services/capability-tips";
import { locationPilot } from "@db/services/location";
import { phonePilot, readPhoneNumber } from "@db/services/phone";
import { env } from "@shared/environment";
import { googleWorkspaceConfigured } from "@shared/google-workspace/connection";
import type { AccessScope } from "@shared/identity/access-scope";
import { artifactStorageConfigured } from "@shared/object-storage/artifacts";
import { taskFilesEnabled } from "@shared/sandbox/pilot";

/**
 * Bro showing a person, a little at a time, what else it can do
 * (CAPABILITY_TIPS_WORKSPACES). The newcomers of 22–24.10 all found calls —
 * the one thing Bro showed them, in the introduction and after the first
 * call's report — and almost none tried anything the introduction only
 * named: reminders, files, pictures, mail and calendar, Yandex orders. After
 * the introduction's first three messages nothing showed more, and «а что
 * ты ещё можешь» got a line of verbs that began with what the person had
 * just done.
 *
 * So, past the introduction, a person's message may carry a context line
 * with what they have not tried yet (`turn_log`, all channels): Bro may end
 * the reply that finishes their request with one offer of the one that
 * carries that very request on, or say nothing. Tips are spaced out, each
 * rests after an offer and stops after a few, and a question of what Bro
 * can do gets the same history to answer from.
 */

type TipChannel = "telegram" | "web";

/** Something Bro can do that a person may never have asked for. */
interface Capability {
  readonly id: string;
  /** Its name in the list of what the person has tried. */
  readonly label: string;
  /** What Bro can do for them, as a tip tells the model. */
  readonly hint: string;
  /** It works only once the person connects or signs in to something. */
  readonly setup: boolean;
  /** A tool whose call in the person's turns means they have tried it. */
  readonly tried: (tool: string) => boolean;
  /** Whether Bro can do it for this workspace in this channel. */
  readonly available: (
    scope: AccessScope,
    channel: TipChannel
  ) => boolean | Promise<boolean>;
}

/** In the order tips offer them: what newcomers took to first goes first. */
const capabilities: readonly Capability[] = [
  {
    available: async (scope) =>
      phonePilot(scope) && (await readPhoneNumber(scope))?.state === "active",
    hint: "позвонить вместо него со своего номера: забронировать столик, записать в сервис или к врачу, что-то узнать или передать",
    id: "call",
    label: "звонки",
    setup: false,
    tried: (tool) => tool === "phone-call",
  },
  {
    available: () => schedulesEnabled(),
    hint: "напомнить о деле в нужный момент — за день до события, к сроку — или повторять дело по расписанию",
    id: "reminders",
    label: "напоминания",
    setup: false,
    tried: (tool) => tool === "schedules-create",
  },
  {
    available: () => googleWorkspaceConfigured(),
    hint: "подключить его почту и календарь Google: сам напомнишь о встречах, бронях и поездках, а без его слова ничего не отправишь",
    id: "google",
    label: "почта и календарь",
    setup: true,
    tried: (tool) => /^(?:gmail|calendar|drive)-|^connect_google$/u.test(tool),
  },
  {
    available: (scope) => yandexPurchasePilot(scope),
    hint: "заказать еду, продукты или такси из Яндекса прямо в этом чате — для этого один раз войти в его Яндекс",
    id: "yandex",
    label: "заказы в Яндексе",
    setup: true,
    tried: (tool) => tool === "yandex_purchase",
  },
  {
    available: (scope) => taskFilesEnabled(scope.workspaceId),
    hint: "разобрать фото или файл и прислать готовый файл: снимки чеков — таблицей расходов, документ — в Word или PDF; собрать презентацию; заполнить и подписать бланк",
    id: "files",
    label: "файлы и документы",
    setup: false,
    tried: (tool) =>
      tool === "task" ||
      tool === "share_file" ||
      tool === "sign_document" ||
      tool === "signature",
  },
  {
    available: () =>
      modelEndpoint() !== undefined && artifactStorageConfigured(),
    hint: "нарисовать открытку, приглашение или картинку — к событию или для кого-то из близких",
    id: "images",
    label: "картинки",
    setup: false,
    tried: (tool) => tool === "generate_image" || tool === "generate_video",
  },
  {
    available: (scope, channel) =>
      channel === "telegram" && locationPilot(scope),
    hint: "по геопозиции из Telegram подсказать, что рядом, и напомнить о деле, когда он придёт в нужное место",
    id: "location",
    label: "геопозиция",
    setup: false,
    tried: (tool) => tool === "place_reminder" || tool.startsWith("location_"),
  },
  {
    available: (scope) => subscriptionsPilot(scope),
    hint: "следить за ценой товара по ссылке или за посылкой Почты России и написать, когда что-то изменится",
    id: "watch",
    label: "слежка за ценой и посылками",
    setup: false,
    tried: (tool) => tool === "watch-create" || tool === "parcel-watch",
  },
];

/**
 * The person's turns before a tip may come: the introduction's own
 * messages, the first three after it (`first-contact`), go first.
 */
const tipAfterTurns = 4;

/** At most one tip in this long, whatever was offered. */
const tipSpacingMs = 6 * 60 * 60_000;

/** A capability offered rests this long before it is offered again… */
const tipRestMs = 3 * 24 * 60 * 60_000;

/** …and after this many offers is not offered any more. */
const maxOffers = 2;

/** The most capabilities one tip names, for Bro to pick the fitting one. */
const tipChoices = 3;

/** A message shorter than this («ок», «спасибо») is no request to follow. */
const minimumWords = 3;

/**
 * A question of what Bro can do as a whole, not «что можешь посоветовать»
 * or «что ты можешь сделать с этим файлом»: «можешь» and «помочь» only at
 * the end of the question or before «ещё», «вообще», «по функционалу».
 */
const capabilityQuestion = stems(
  String.raw`что (ты )?(вообще |ещ[её] )*умеешь`,
  String.raw`что (ты )?(вообще |ещ[её] )*можешь(?=\s*(?:$|[?!.,)]|ещ[её]|вообще|по\s))`,
  String.raw`чем (ты )?(ещ[её] )?(можешь )?(мне )?(помочь|помогаешь|быть полез\p{L}*)(?=\s*(?:$|[?!.,)]))`,
  String.raw`(твои|какие у тебя) (возможност|функци)`,
  String.raw`what (else )?(can|do) you do(?!\p{L})|what are you capable of`
);

const tipHeading =
  "Подсказка от кода, не слова человека, — только к его сообщению сразу после этой строки. Этот человек ещё ни разу не пробовал вот что из того, что ты умеешь:";

/**
 * What Bro does with a tip, tried on the production model (25.10, eight
 * runs each): the stops come first and say nothing of themselves, or a
 * complaint got a tip in two of six; and a tip only «if it fits» lost to
 * Bro's own next step every time, so it may share that step's question.
 * The hints above name no example Bro could copy into an unrelated answer
 * («утром пришлю погоду» under a concert's date). eve keeps a turn's context
 * in the conversation, so a tip says it is for its own message alone.
 */
const tipRule =
  "Он не знает, что ты так умеешь, — покажи, но только к месту. Сначала проверь: человек недоволен, жалуется или раздражён, дело ещё идёт, ты ждёшь от него ответа, без которого дело не сделать, или он просил не предлагать лишнего — тогда ничего из этого не предлагай. Иначе в конце последнего сообщения предложи одно из этого, которое продолжает именно его дело: одной фразой, на его же деле, с конкретикой из разговора, — что сделаешь, и спроси, сделать ли. Свой следующий шаг можешь предложить в том же вопросе. Ничего из этого его дело не продолжает — не предлагай. Без списка и рекламы, об этой подсказке не упоминай, само не начинай. К следующим его сообщениям она не относится: новую код пришлёт сам.";

const askedHeading =
  "Для ответа на вопрос, что ты умеешь, в сообщении сразу после этой строки — от кода, не слова человека.";

const askedRule =
  "Отвечай по навыку about-bro, но примеры бери прежде всего из того, чего он ещё не пробовал, и подстраивай под то, что знаешь о нём; уже знакомое не выдавай за новое, а то, что требует подключения (почта, календарь, заказы), не называй, пока он сам не спросит.";

function wordCount(words: string) {
  return words.match(/\p{L}+/gu)?.length ?? 0;
}

function bullets(list: readonly Capability[]) {
  return list.map((capability) => `• ${capability.hint}`).join("\n");
}

/** Whether the workspace is in the pilot: its id, or `*`. */
function tipsPilot(scope: Pick<AccessScope, "workspaceId">) {
  const list = env.CAPABILITY_TIPS_WORKSPACES ?? [];
  return list.includes("*") || list.includes(scope.workspaceId);
}

/**
 * What a person's message carries about what else Bro can do: a tip for Bro
 * to offer once the request is done, the history to answer «что ты умеешь»
 * from, or nothing. `words` is what the person said (a voice note's
 * transcript included). A channel calls it only for a message about to
 * start a turn: a tip it returns counts as offered. A lookup that fails
 * leaves the message as it was.
 */
export async function capabilityTipContext(
  scope: AccessScope,
  message: { readonly channel: TipChannel; readonly words: string }
): Promise<string[]> {
  if (!tipsPilot(scope)) return [];
  try {
    const asked = capabilityQuestion.test(message.words);
    if (!asked && wordCount(message.words) < minimumWords) return [];
    const use = await readCapabilityHistory(scope.workspaceId);
    if (use.personTurns < (asked ? 1 : tipAfterTurns)) return [];
    // Most messages stop here: the claim checks the spacing again, under
    // the lock, but the reads below are not needed for a tip that cannot go.
    if (
      !asked &&
      use.lastTipAt !== null &&
      Date.now() - use.lastTipAt.getTime() < tipSpacingMs
    ) {
      return [];
    }
    const tried = capabilities.filter(
      (capability) =>
        (capability.id === "google" && use.googleConnected) ||
        use.tools.some((tool) => capability.tried(tool))
    );
    const open = await Promise.all(
      capabilities
        .filter((capability) => !tried.includes(capability))
        .map(async (capability) =>
          (await capability.available(scope, message.channel))
            ? capability
            : undefined
        )
    );
    const untried = open.filter((capability) => capability !== undefined);
    if (asked) {
      return askedContext(
        tried,
        untried.filter((capability) => !capability.setup)
      );
    }
    const claimed = await claimCapabilityTip(
      scope.workspaceId,
      untried.map((capability) => capability.id),
      {
        limit: tipChoices,
        maxOffers,
        restMs: tipRestMs,
        spacingMs: tipSpacingMs,
      }
    );
    if (claimed.length === 0) return [];
    console.info("[capabilities] tip", {
      offered: claimed,
      tried: tried.map((capability) => capability.id),
    });
    const offered = untried.filter((capability) =>
      claimed.includes(capability.id)
    );
    return [[tipHeading, bullets(offered), tipRule].join("\n")];
  } catch (error) {
    console.warn("[capabilities] tip lookup failed", {
      cause: error instanceof Error ? error.name : "unknown",
    });
    return [];
  }
}

function askedContext(
  tried: readonly Capability[],
  untried: readonly Capability[]
) {
  if (untried.length === 0) return [];
  return [
    [
      askedHeading,
      ...(tried.length > 0
        ? [
            `Уже пробовал с тобой: ${tried.map((capability) => capability.label).join(", ")}.`,
          ]
        : []),
      "Ещё не пробовал, и это работает без подключений:",
      bullets(untried),
      askedRule,
    ].join("\n"),
  ];
}

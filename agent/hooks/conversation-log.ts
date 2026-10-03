import { defineHook } from "eve/hooks";
import {
  appendConversationLine,
  conversationLineLimit,
} from "@db/services/conversation-log";
import { crossChannelPilot } from "@agent/lib/conversation/pilot";
import { oneTimeCodeRanges } from "@agent/lib/browser-use/said";
import { redactRanges } from "@agent/lib/memory/digest/redact";
import { unsafeMemoryRanges } from "@shared/memory/schema";
import { documentNumberRanges } from "@agent/lib/privacy/document-numbers";
import { recapChannels } from "@agent/lib/conversation/recap";
import { startedByPerson } from "@agent/lib/mode";
import { scopeFromPrincipal } from "@agent/lib/principal-scope";
import { isBackgroundTurnText } from "@shared/chat/background-turn";

/**
 * What the person says in a turn they started, a line per message, into
 * `conversation_log` for the recap another channel shows
 * (`agent/lib/conversation/recap.ts`). Only for the pilot
 * (CROSS_CHANNEL_WORKSPACES), only the web chat, Telegram and iMessage. A
 * turn Bro opened for itself — a browser run's report, a schedule's worker
 * or report — speaks for nobody and is not logged, nor is a task's report,
 * which eve brings in under the person's caller
 * (`execution.background_task`). What Bro said is not logged: its messages
 * quote mail, pages and task output, and the recap reaches another chat as
 * user-role turn context. One-time codes, card numbers and passwords are
 * cut out first, by the filter memory keeps out of its records
 * (`unsafeMemoryRanges`): the log is a store of its own, and a recap would
 * carry an SMS code to another chat. That filter wants a word for the code,
 * and a code is passed on bare as often — «482913», «код пришёл 482913» —
 * so a short message's number goes too, as a browser errand would read it
 * when it waits for one (`oneTimeCodeRanges`). Memory's filter also takes
 * a password only after «:» or with a digit in it, and knows no passport,
 * SNILS or a card's CVV: the log cuts those by rules of its own and the
 * benchmark's journal (`agent/lib/privacy/document-numbers.ts`). A failed
 * write costs the line, never the turn.
 */
export default defineHook({
  events: {
    async "message.received"(event, ctx) {
      if (event.data.kind !== undefined) return;
      const text = event.data.message;
      if (isBackgroundTurnText(text)) return;
      // A subagent inherits its parent's caller but is not where anyone talks.
      if (ctx.session.parent) return;
      const channel = ctx.channel.kind;
      if (channel === undefined || !recapChannels.has(channel)) return;
      if (!startedByPerson(ctx)) return;
      const caller = ctx.session.auth.current ?? ctx.session.auth.initiator;
      if (!caller) return;
      try {
        const scope = scopeFromPrincipal(caller);
        if (!(await crossChannelPilot(scope))) return;
        await appendConversationLine(scope.workspaceId, {
          channel,
          createdAt: new Date(event.meta.at),
          sessionId: ctx.session.id,
          text: withoutSecrets(text),
          turnId: event.data.turnId,
        });
      } catch (error) {
        // The error of a failed insert quotes its parameters, the line among
        // them: only its name is logged.
        console.warn("[cross-channel] a conversation line was not logged", {
          cause: error instanceof Error ? error.name : "unknown",
          sessionId: ctx.session.id,
        });
      }
    },
  },
});

/** How many words beside a number still read as passing a code on. */
const codeReplyWords = 3;

/**
 * How much of a message the filters read: the line keeps 500 characters,
 * and the rest of the 600 lets a secret that crosses the cut still read as
 * one. The filters are not linear — each number in `oneTimeCodeRanges`
 * looks back over the text before it — and the web chat takes a message of
 * any length: a 100 KB paste held the one eve process for most of a minute.
 */
const readLimit = conversationLineLimit + 100;

/**
 * The line the log keeps of a message: its first 500 characters with the
 * credentials, codes, card and document numbers cut out. A secret that
 * starts before the cut is cut out whole; nothing past the cut comes in,
 * whatever the placeholders saved.
 */
function withoutSecrets(message: string) {
  const characters = Array.from(message.trim());
  const text = characters.slice(0, readLimit).join("");
  const kept = characters.slice(0, conversationLineLimit).join("").length;
  const words = text.match(/\p{L}+/gu)?.length ?? 0;
  const secrets = [
    ...unsafeMemoryRanges(text),
    ...oneTimeCodeRanges(text, { awaitingCode: words <= codeReplyWords }),
    ...documentNumberRanges(text),
    ...cardCodeRanges(text),
    ...namedSecretRanges(text),
  ].flatMap(([start, end]) =>
    start < kept ? [[start, Math.min(end, kept)] as const] : []
  );
  return redactRanges(text.slice(0, kept), secrets);
}

/**
 * A card's three or four digit code by its name: «cvv 123», «код с обратной
 * стороны карты 123», «три цифры на обороте: 123», «код 123 на обороте».
 * «Код» or «цифры» count only with the card or its back named before the
 * number or after it in the same clause; a door's or an order's code stays.
 */
const cardCodePattern =
  /(?<!\p{L})(cvv2?|cvc2?|cv2|код\p{L}*|цифр\p{L}*|обратн\p{L}*\s+сторон\p{L}*)(?!\p{L})([^\d\n]{0,40}?)(?<!\d)(\d{3,4})(?!\d)/dgiu;
const cardNamedPattern = /карт|card|оборот|обратн|сзади|\bback\b/iu;
/** The rest of the number's clause, where the card may be named after it. */
const clauseAfterPattern = /^[^\n,.;!?]{0,30}/u;

function cardCodeRanges(text: string) {
  return [...text.matchAll(cardCodePattern)].flatMap((match) => {
    const [, name = "", gap = ""] = match;
    const range = match.indices?.[3];
    if (range === undefined) return [];
    const after = clauseAfterPattern.exec(text.slice(range[1]))?.[0] ?? "";
    return /^cv/iu.test(name) || cardNamedPattern.test(name + gap + after)
      ? [range]
      : [];
  });
}

/**
 * A word that names a secret, and the secret after it: «пароль qwerty»,
 * «логин ivan, пароль qwerty», «пароль от почты Kot2024», «секретное слово
 * банка Мурзик», «кодовое слово — ромашка», «пароль теперь qwerty».
 * Memory's filter takes a password only after «:» or with a digit in it.
 */
const secretNamePattern =
  /(?<!\p{L})(?:парол\p{L}*|password|passwd|passcode|pwd|(?:секретн|кодов|контрольн)\p{L}*\s+(?:слов|фраз)\p{L}*|secret\s+(?:word|phrase)|code\s*word|passphrase)(?!\p{L})/giu;

/** A word that says who the secret is for: «пароль wifi …», «слово банка …». */
const ownerPattern =
  /^(?:банк\p{L}*|карт\p{L}*|почт\p{L}*|ящик\p{L}*|аккаунт\p{L}*|уч[её]тк\p{L}*|кабинет\p{L}*|личн\p{L}*|профил\p{L}*|сбер\p{L}*|тинько\p{L}*|втб|альф\p{L}*|госуслуг\p{L}*|wi-?fi|вай-?фа\p{L}*|роутер\p{L}*|интернет\p{L}*|домашн\p{L}*|рабоч\p{L}*|телефон\p{L}*|ноутбук\p{L}*|компьютер\p{L}*|приложени\p{L}*|сайт\p{L}*)$/iu;
const prepositionPattern = /^(?:от|для|к|у|в|из|с|на|for|to|from|on|at)$/iu;
const separatorPattern = /^(?:[:=—–-]+|это|is)$/iu;
/** Another credential's name: what follows it is not this secret. */
const nextNamePattern =
  /^(?:логин\p{L}*|login|username|user|почта|email|e-mail)$/iu;

/**
 * A word after the secret's name that is no secret but speaks about it —
 * «пароль от wifi поменяли?», «пароль не подходит», «новый пароль какой?»,
 * «пароль теперь qwerty». A word missing here costs the line a word, never
 * a secret: the rules skip it and cut the next one.
 */
const notSecretPattern =
  /^(?:не|ни|и|а|но|или|же|ли|бы|уже|ещ[её]|тоже|так\p{L}*|там|тут|вот|есть|нет|был\p{L}*|будет|я|ты|он|она|мы|вы|они|мне|меня|тебе|тебя|нам|вам|ему|ей|мо[йяеёи]\p{L}*|тво\p{L}*|ваш\p{L}*|наш\p{L}*|сво\p{L}*|эт\p{L}*|тот|та|то|те|котор\p{L}*|как\p{L}*|где|когда|зачем|почему|если|что|чтобы|вдруг|сейчас|теперь|потом|снова|опять|очень|слишком|совсем|вообще|точно|кажется|вроде|сам\p{L}*|поменя\p{L}*|смен\p{L}*|измен\p{L}*|забыл\p{L}*|забуд\p{L}*|сброс\p{L}*|восстанов\p{L}*|подход\p{L}*|подошёл|подошел|неверн\p{L}*|верн\p{L}*|правильн\p{L}*|нов\p{L}*|стар\p{L}*|прежн\p{L}*|приш\p{L}*|напиш\p{L}*|напис\p{L}*|напомн\p{L}*|подскаж\p{L}*|скаж\p{L}*|покаж\p{L}*|запиш\p{L}*|отправ\p{L}*|получ\p{L}*|скин\p{L}*|введ\p{L}*|ввод\p{L}*|ввёл|ввел|нуж\p{L}*|надо|прост\p{L}*|сложн\p{L}*|слаб\p{L}*|надёжн\p{L}*|надежн\p{L}*|длинн\p{L}*|коротк\p{L}*|сохран\p{L}*|храни\p{L}*|помн\p{L}*|запомн\p{L}*|зна\p{L}*|лежит|the|a|an|was|has|not|reset|changed|is|from|for|to)$/iu;

/**
 * The words of the clause after `from`, with where each one stands: up to
 * the punctuation that ends it, or a new line after its first word.
 */
function clauseWords(text: string, from: number) {
  const words: { end: number; start: number; word: string }[] = [];
  let previousEnd = from;
  for (const match of text.slice(from, from + 80).matchAll(/\S+/gu)) {
    const start = from + match.index;
    if (words.length > 0 && text.slice(previousEnd, start).includes("\n")) {
      break;
    }
    previousEnd = start + match[0].length;
    // Quotes and the punctuation that ends a clause are not the secret's.
    const lead = /^[«"'(]*/u.exec(match[0])?.[0].length ?? 0;
    const word = match[0].slice(lead).replace(/[»"'),.;:!?]+$/u, "");
    if (word.length > 0) {
      words.push({
        end: start + lead + word.length,
        start: start + lead,
        word,
      });
    }
    if (/[,.;!?]$/u.test(match[0]) || words.length >= 6) break;
  }
  return words;
}

/**
 * Walks the clause after each secret's name. Words about the secret, its
 * owner («от почты», «банка») and a separator are passed over; the first
 * word left is the secret. After a separator that word goes whatever it
 * is. Once an owner is named — «пароль от личного кабинета Kot2024», «от
 * wifi qwerty если что» — the owner may take more words than the rules
 * know, so every word left in the clause goes: a word of the owner lost is
 * the cheap side of a password kept. A best effort by design: a word after
 * an owner may go («пароль от почты [завтра]») and a password without its
 * name stays («pass: hunter2», «пароль везде kotik») — the accepted price.
 */
function namedSecretRanges(text: string) {
  return [...text.matchAll(secretNamePattern)].flatMap((match) => {
    const after = match.index + match[0].length;
    let explicit = /^\s*[:=]/u.test(text.slice(after));
    let owned = false;
    let ownerNext = false;
    const ranges: (readonly [number, number])[] = [];
    for (const { end, start, word } of clauseWords(text, after)) {
      if (nextNamePattern.test(word)) break;
      if (separatorPattern.test(word)) {
        explicit = true;
        continue;
      }
      if (!explicit && prepositionPattern.test(word)) {
        // «смени пароль на qwerty123»: «на» names the new one, not an owner.
        ownerNext = !/^на$/iu.test(word);
        continue;
      }
      if (!explicit && (ownerNext || ownerPattern.test(word))) {
        ownerNext = false;
        owned = true;
        continue;
      }
      if (!explicit && notSecretPattern.test(word)) continue;
      ranges.push([start, end]);
      if (!owned) break;
      explicit = false;
    }
    return ranges;
  });
}

import { getGoogleWorkspaceAccess } from "@db/services/settings";
import {
  type GoogleWorkspaceAccess,
  googleWorkspaceConfigured,
  readGoogleWorkspaceConnection,
} from "@shared/google-workspace/connection";
import type { AccessScope } from "@shared/identity/access-scope";

/**
 * How the person narrows Bro's Google access or switches it off, as they
 * should hear it. On 25.09 (RU d14) `connect_google` told the model that
 * read-only and disconnecting were possible, in a tool hint inside
 * `abilities`, and the person heard only «подключён с полным доступом».
 */
export function googleAccessOptions(access: GoogleWorkspaceAccess) {
  // No address here: the only link `connect_google` may hand over is the
  // one it mints for signing in.
  const disconnect =
    "Отключить Google совсем — «отключи Google» или кнопка «Отключить» у Google в кабинете.";
  if (access === "read_only") {
    return `Google подключён только на чтение: Бро ничего там не отправляет и не меняет. ${disconnect}`;
  }
  // Composio's Google app is approved only for broad scopes, so even the
  // read-only setup asks Google for them, and Bro refuses every write
  // itself (`googleWriteApproval`): the person is told so.
  return `Google подключён с полным доступом. Его можно сузить до «только чтение»: тогда Бро только читает почту, календарь, контакты и Диск и ничего там не отправляет, не сохраняет и не меняет — этот запрет держит сам Бро, даже если экран согласия Google покажет доступ шире. Достаточно написать «только чтение» — Бро пришлёт ссылку, чтобы заново войти в Google. ${disconnect}`;
}

/**
 * Writing or sending to someone else: «не пиши мне ночью» is about Bro's own
 * messages to the person, which no Google grant carries.
 */
const writingVerb =
  "(?:пиш|писа|напиш|отправ|отсыл|шли|слать|отвеча|рассыл|send|writ|e-?mail|messag|repl)\\p{L}*(?!\\p{L})(?!\\s+(?:мне|me)(?!\\p{L}))";

/**
 * Rules that keep Bro from writing or sending in the person's name: «никому
 * не пиши без моего ок», «ничего не отправляй без спроса», «не трогай
 * почту», «never email anyone without asking». A rule about paying alone
 * is not one.
 */
const sendingRestrictions = [
  new RegExp(
    `(?<!\\p{L})(?:не|без|never|don'?t|do not)\\s+(?:\\p{L}+\\s+){0,3}?${writingVerb}`,
    "iu"
  ),
  new RegExp(
    `(?<!\\p{L})${writingVerb}[^.!?]*?(?:без|только\\s+(?:с|после)|without|only\\s+(?:with|after))\\s+(?:\\p{L}+\\s+)?(?:ок|окей|ok|okay|спрос|разрешени|согласи|подтвержд|одобрени|asking|approval|permission|consent)`,
    "iu"
  ),
  /(?<!\p{L})не\s+(?:трогай|меняй|удаляй)\s+(?:\p{L}+\s+)?(?:почт|письм|календар)/iu,
];

export function restrictsSending(ruleText: string) {
  return sendingRestrictions.some((pattern) => pattern.test(ruleText));
}

/**
 * What the result of saving a rule adds when the rule limits what Bro sends
 * and Google is connected with full access: the same limit can be made
 * binding at the grant, and the person should hear that right away, not
 * only when they think to ask (RU d14).
 */
export async function ruleAccessNote(scope: AccessScope, ruleText: string) {
  if (!restrictsSending(ruleText) || !googleWorkspaceConfigured()) {
    return undefined;
  }
  try {
    const access = await getGoogleWorkspaceAccess(scope);
    if (access !== "full") return undefined;
    const connection = await readGoogleWorkspaceConnection(
      scope.userId,
      access
    );
    if (connection.state !== "connected") return undefined;
  } catch (error) {
    console.warn("[privacy] could not read the Google access for a rule", {
      message: error instanceof Error ? error.message : String(error),
    });
    return undefined;
  }
  return `This rule limits what you send, and Google is connected with full access. Confirm the rule, then in the same reply add one line in your own words: ${googleAccessOptions("full")} It is an option, not a question to wait on: change nothing until the person asks.`;
}

import {
  countRecentBugReports,
  fileBugReport,
  findBugReportByForward,
  listUnforwardedBugReports,
  markBugReportForwarded,
  recordBugReportReply,
} from "@db/services/bug-reports";
import { findChannelIdentity } from "@db/services/channel-identities";
import { ownerMessageLabels } from "@agent/lib/owner-alert";
import {
  callBotApi,
  sentMessageSchema,
  type BugBotMessage,
  type BugBotUpdate,
} from "./api";

export const maximumReportLength = 3500;
export const reportsPerHour = 5;
const hourMs = 60 * 60_000;
// Telegram refuses a photo caption longer than this.
const captionLimit = 1024;

const greeting =
  "Опишите, что сломалось, одним сообщением — можно со скриншотом. Я передам это разработчику и отвечу, как только он напишет.";
const emptyNotice =
  "Не вижу описания. Напишите, что сломалось, текстом или подпишите скриншот.";

interface Target {
  readonly botToken: string;
  readonly ownerChatId: string;
}
type Report = Awaited<ReturnType<typeof listUnforwardedBugReports>>[number];

/** What the owner reads above a report: number, who, workspace, when. */
function reportHeader(report: Report) {
  const who = [report.firstName, report.username && `@${report.username}`]
    .filter(Boolean)
    .join(" ");
  const when = report.createdAt.toISOString().slice(0, 16).replace("T", " ");
  return [
    `${ownerMessageLabels.bug} №${String(report.id)}`,
    who || `id ${report.telegramUserId}`,
    report.workspaceId ?? "без кабинета",
    `${when} UTC`,
  ].join(" · ");
}

function say(target: Target, chatId: string, text: string) {
  return callBotApi(
    target.botToken,
    "sendMessage",
    { chat_id: chatId, text },
    sentMessageSchema
  );
}

/**
 * One update, handled once: the owner's reply goes to the person it answers,
 * a private message from anyone else is filed as a report. Only the owner's
 * chat may answer, so a reply typed anywhere else cannot reach a person.
 */
export async function handleBugBotUpdate(
  target: Target,
  update: BugBotUpdate,
  now = new Date()
) {
  const message = update.message;
  if (!message) return;
  if (String(message.chat.id) === target.ownerChatId) {
    await handleOwnerReply(target, update.update_id, message);
    return;
  }
  if (message.chat.type !== "private") return;
  const from = message.from;
  if (!from || from.is_bot) return;
  const chatId = String(message.chat.id);
  const text = (message.text ?? message.caption ?? "").trim();
  if (/^\/start(?:@\w+)?(?:\s|$)/u.test(text)) {
    await say(target, chatId, greeting);
    return;
  }
  const photoFileId = message.photo?.at(-1)?.file_id;
  if (!text && !photoFileId) {
    await say(target, chatId, emptyNotice);
    return;
  }
  if (text.length > maximumReportLength) {
    await say(
      target,
      chatId,
      `Получилось слишком длинно (больше ${String(maximumReportLength)} знаков). Опишите короче.`
    );
    return;
  }
  const telegramUserId = String(from.id);
  const recent = await countRecentBugReports(
    telegramUserId,
    new Date(now.getTime() - hourMs)
  );
  if (recent >= reportsPerHour) {
    await say(
      target,
      chatId,
      "Вы уже отправили несколько сообщений за последний час. Подождите немного и напишите ещё раз."
    );
    return;
  }
  const identity = await findChannelIdentity("telegram", telegramUserId);
  const report = await fileBugReport({
    chatId,
    createdAt: now,
    firstName: from.first_name ?? null,
    photoFileId: photoFileId ?? null,
    telegramUserId,
    text,
    updateId: update.update_id,
    username: from.username ?? null,
    workspaceId: identity?.workspaceId ?? null,
  });
  // Filed already: this update came again after a crash.
  if (!report) return;
  await say(target, chatId, `Принято, №${String(report.id)}. Спасибо!`);
  await forwardBugReport(target, report);
}

/** Sends a filed report to the owner's chat and remembers the message. */
async function forwardBugReport(target: Target, report: Report) {
  const header = reportHeader(report);
  const body = report.text ? `${header}\n\n${report.text}` : header;
  let messageId: number | undefined;
  if (report.photoFileId && body.length <= captionLimit) {
    const sent = await callBotApi(
      target.botToken,
      "sendPhoto",
      { caption: body, chat_id: target.ownerChatId, photo: report.photoFileId },
      sentMessageSchema
    );
    if (sent.ok) messageId = sent.result.message_id;
  } else {
    const sent = await say(target, target.ownerChatId, body);
    if (sent.ok) {
      messageId = sent.result.message_id;
      if (report.photoFileId) {
        await callBotApi(
          target.botToken,
          "sendPhoto",
          {
            caption: `Скриншот к №${String(report.id)}`,
            chat_id: target.ownerChatId,
            photo: report.photoFileId,
            reply_to_message_id: sent.result.message_id,
          },
          sentMessageSchema
        );
      }
    }
  }
  if (messageId === undefined) {
    throw new Error(`Bug report ${String(report.id)} was not forwarded.`);
  }
  await markBugReportForwarded(report.id, messageId);
}

async function handleOwnerReply(
  target: Target,
  updateId: number,
  message: BugBotMessage
) {
  const replyTo = message.reply_to_message?.message_id;
  const text = message.text?.trim();
  if (replyTo === undefined || !text) return;
  const report = await findBugReportByForward(replyTo);
  if (!report) return;
  // Recorded before the send: an update read twice must not reach the person
  // twice. A failed send is told to the owner, who can write again.
  const first = await recordBugReportReply({
    reportId: report.id,
    text,
    updateId,
  });
  if (!first) return;
  const sent = await say(
    target,
    report.chatId,
    `Ответ по обращению №${String(report.id)}:\n\n${text}`
  );
  if (!sent.ok) {
    await say(
      target,
      target.ownerChatId,
      `Ответ на №${String(report.id)} не дошёл до человека (Telegram ${String(sent.code)}). Напишите его ещё раз.`
    );
  }
}

/** Reports filed whose forward failed, tried again on the next tick. */
export async function forwardPendingBugReports(target: Target) {
  const pending = await listUnforwardedBugReports();
  /* oxlint-disable eslint/no-await-in-loop -- Reports reach the owner in the order they were filed. */
  for (const report of pending) {
    try {
      await forwardBugReport(target, report);
    } catch (error) {
      console.warn("[bug-bot] a report could not be forwarded", {
        cause: error,
        id: report.id,
      });
      return;
    }
  }
  /* oxlint-enable eslint/no-await-in-loop */
}

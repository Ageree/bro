import { browserUseConfigured } from "@agent/lib/browser-use/client";
import { composioConfigured } from "@shared/composio/api";
import { applicationOrigin } from "@shared/environment/origin";
import { googleWorkspaceConfigured } from "@shared/google-workspace/connection";

/**
 * A cabinet page by the address the person opens, or by its name alone when
 * this deployment does not know its own origin: Bro gives only links a tool
 * handed it, so the result carries the real one.
 */
function cabinetPage(path: string, name: string) {
  try {
    return `${name} (${new URL(path, applicationOrigin()).toString()})`;
  } catch {
    return name;
  }
}

/**
 * How the person removes each kind of data that is not a memory record, said
 * the same way after «удали всё, что ты про меня помнишь» and on «где мои
 * данные». On 25.09 (RU d14) Bro answered both without naming the Google
 * switch, the cabinet, or what forgetting leaves behind.
 */
export function removalOutsideMemory() {
  return [
    `Личные данные (имя, телефон, почта, адрес, дата рождения) — это не память: они убираются в кабинете, ${cabinetPage("/personal-info", "раздел «Личные данные»")}, или просьбой («удали мой адрес»).`,
    ...(googleWorkspaceConfigured()
      ? [
          `Google — «отключи Google» или ${cabinetPage("/workspace", "кабинет")}: Бро теряет доступ, ключ удаляется из Composio. В самом Google ничего не удаляется: письма, черновики и события остаются как были.`,
        ]
      : []),
    ...(composioConfigured()
      ? [
          `Notion, Slack и другие подключённые приложения — «отключи Notion» или ${cabinetPage("/workspace", "кабинет")}.`,
        ]
      : []),
    "Расписания и напоминания — «покажи мои расписания», затем «удали …» или «останови все расписания».",
    `Сейф — входы, карты, адреса и контакты — в кабинете, ${cabinetPage("/vault", "раздел «Сейф»")}.`,
    ...(browserUseConfigured()
      ? [
          "Входы на сайты в облачном браузере — «забудь мои входы на сайты»: профиль браузера удаляется со всеми куки, и следующее поручение входит заново; «не заходи больше в <сайт>» — Бро перестаёт открывать этот сайт сам.",
        ]
      : []),
    "Историю чатов, заказы, итоги поручений и сохранённые файлы Бро сам не удаляет.",
  ];
}

/**
 * What a forget-everything result adds for the reply: what stays outside
 * memory and how the person removes each part, told without asking whether
 * to remove it.
 */
export function afterForgetting() {
  return {
    outsideMemory: removalOutsideMemory(),
    reply:
      "In the one message that says what was forgotten, also tell the person what is not memory and stays, and how they remove each part (outsideMemory), in your own words. Do not ask whether to remove any of it, and remove nothing else yourself.",
  };
}

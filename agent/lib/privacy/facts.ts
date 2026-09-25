import { browserUseConfigured } from "@agent/lib/browser-use/client";
import { customProxy } from "@agent/lib/browser-use/proxy";
import { supermemoryConfigured } from "@agent/lib/memory/supermemory";
import { yooKassaConfigured } from "@db/services/yookassa";
import { composioConfigured } from "@shared/composio/api";
import { env } from "@shared/environment";
import { openRouterActive } from "@shared/model/provider";
import { photonConfigured } from "@shared/photon/credentials";

/**
 * What Bro keeps about the person and where, as this deployment is built:
 * the app and the agent run on Vercel, the records live in Postgres on Neon,
 * files in private Vercel Blob storage. On 25.09 (RU d14) Bro said only «в
 * облаке сервиса» and «Postgres в облаке».
 */
export function keptData() {
  return [
    `Память (факты, предпочтения, правила), сохранённые дела, личные данные (имя, телефон, почта, адрес), расписания, сейф, заказы и итоги поручений${yooKassaConfigured() ? ", история оплат подписки" : ""}${browserUseConfigured() ? ", сайты, где облачный браузер держит вход, со ссылкой на страницу аккаунта на каждом" : ""} — в базе Postgres в Neon.`,
    "Пароли и карты из сейфа лежат там же в зашифрованном виде (AES-256-GCM): языковая модель их не видит.",
    "Файлы — вложения писем, файлы с Диска, нарисованные картинки и снимки страниц из поручений — в приватном хранилище Vercel Blob.",
    "Приложение и сам Бро работают на Vercel; история переписки (сессии Бро) хранится там же, в Vercel Workflow.",
  ];
}

/**
 * Which outside services see the person's data, and what of it: every one
 * this deployment is configured with, and only those, with the model the
 * workspace runs on. The result tells the model to add none of its own, so a
 * configured service missing here is a service the person never hears of.
 * The judges of RU d14 (25.09) missed the language model's provider and the
 * cloud browser, which Bro never named.
 */
export function dataProcessors(modelId: string) {
  return [
    openRouterActive()
      ? `Сообщения и всё, что Бро читает для ответа (письма, события, страницы, память), обрабатывает языковая модель ${modelId}: запрос идёт через OpenRouter к провайдеру, который эту модель запускает. Голосовые сообщения распознаёт и картинки рисует тоже модель через OpenRouter, а запросы веб-поиска OpenRouter передаёт поисковикам Exa и Perplexity.`
      : `Сообщения и всё, что Бро читает для ответа (письма, события, страницы, память), обрабатывает языковая модель ${modelId}: запрос идёт через Vercel AI Gateway к её провайдеру.`,
    ...(browserUseConfigured()
      ? [
          "Поручения на сайтах выполняет облачный браузер Browser Use: он видит страницы и данные, нужные поручению, получает пароль или карту из сейфа только на время запуска и только для сайта поручения и хранит куки сайтов, куда входил, в профиле браузера.",
          ...keepAliveVisits(),
        ]
      : []),
    ...(customProxy() !== undefined && browserUseConfigured()
      ? [
          "Облачный браузер ходит на сайты через прокси-сервер деплоя: прокси видит, на какие сайты он заходит.",
        ]
      : []),
    ...(composioConfigured()
      ? [
          "Доступ к Google, Notion, Slack и другим подключённым приложениям держит Composio: там хранятся ключи от этих аккаунтов, и через него идут запросы к ним.",
        ]
      : []),
    ...(supermemoryConfigured()
      ? [
          "Записи памяти, кроме помеченных как только локальные, могут индексироваться в Supermemory для поиска по смыслу; забытое оттуда тоже удаляется.",
        ]
      : []),
    "Адреса для расчёта дороги уходят в открытые сервисы OpenStreetMap.",
    ...(yooKassaConfigured()
      ? [
          "Оплату подписки принимает ЮKassa: карту человек вводит на её странице, а Бро передаёт ей только сумму и номер кабинета; данные карты Бро не видит и не хранит.",
        ]
      : []),
    ...messengers(),
  ];
}

/**
 * The visits Bro makes on its own, with no errand and no message: the
 * person hears of them here or not at all.
 */
function keepAliveVisits() {
  const days = env.BROWSER_USE_SIGN_IN_REFRESH_DAYS;
  if (days === 0) return [];
  return [
    `Чтобы вход не пропадал, раз в ${String(days)} дн. облачный браузер сам, без поручения, открывает страницу аккаунта на сайтах, где за последний месяц было поручение и он вошёл (кроме Госуслуг и сайтов, куда человек просил не заходить), ничего там не нажимает и закрывает её.`,
  ];
}

function messengers() {
  const names = [
    ...(env.TELEGRAM_BOT_TOKEN === undefined ? [] : ["Telegram"]),
    ...(photonConfigured() ? ["iMessage (через сервис Photon)"] : []),
  ];
  return [
    ...(names.length === 0
      ? []
      : [
          `Переписка в ${names.join(" и ")} проходит и через ${names.length > 1 ? "эти мессенджеры" : "этот мессенджер"}.`,
        ]),
    // The sign-in code goes out as an iMessage through Photon
    // (`sendPhoneCode`), whichever chat the person uses afterwards.
    ...(photonConfigured()
      ? [
          "Код для входа по номеру телефона приходит через Photon: сервис видит номер и код.",
        ]
      : []),
  ];
}

/**
 * Neither the deployment's settings nor its code name a region for any of
 * these services, so Bro cannot say where the servers stand — and must not
 * guess «в России» for a person who asks because of 152-ФЗ.
 */
export const serverLocation =
  "В каких странах стоят серверы этих сервисов, Бро не знает: регион нигде в его настройках не записан. Утверждать, что данные хранятся в России (или что за её пределами), он не может.";

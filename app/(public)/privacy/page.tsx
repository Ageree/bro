import type { Metadata } from "next";
import Link from "next/link";
import { Masthead } from "@web/components/paper/masthead";
import { env } from "@shared/environment";

export const metadata: Metadata = {
  title: { absolute: "Политика конфиденциальности — bro" },
  description:
    "Какие данные «bro» собирает, где они хранятся, кому передаются и как их удалить.",
  robots: { index: false },
};

/**
 * Section 5 follows the deployment's `OWNER_TRANSCRIPTS` flag, read at request
 * time, so the page never promises what the deployment does not do.
 */
export const dynamic = "force-dynamic";

const contactEmail = "solsav1703@gmail.com";

const proseLinkClassName = "underline underline-offset-[0.2em]";

/**
 * Document — paper, set like the offer: one column of prose divided by
 * hairlines. The services named in clause 3 are the ones `privacy` tells Bro
 * to name (`agent/lib/privacy/facts.ts`); keep the two lists in step.
 */
export default function Page() {
  const retentionDays = env.OWNER_TRANSCRIPTS_RETENTION_DAYS;
  const transcripts = env.OWNER_TRANSCRIPTS === "on";

  return (
    <div className="flex min-h-svh flex-col">
      <Masthead />

      <main className="mx-auto w-full max-w-[44rem] px-bro-pad pt-[0.6rem] pb-20 [&_h2]:mt-8 [&_h2]:mb-2 [&_p]:mb-[0.55rem]">
        <h1 className="type-doc-heading mb-[0.35rem]">
          Политика конфиденциальности
        </h1>
        <p className="type-fine mb-8 text-muted-foreground">
          сервиса «bro» · редакция от 15.10.2026
        </p>

        <h2 className="type-clause-title">1. Кто обрабатывает данные</h2>
        <p className="type-prose">
          Оператор персональных данных — ИП Соловьев Савелий Андреевич (ИНН
          780159467840, ОГРНИП 325784700145981), далее — «Исполнитель». Сервис
          «bro» — персональный ИИ-ассистент по адресу{" "}
          <a className={proseLinkClassName} href="https://brobro.tech">
            brobro.tech
          </a>
          . Условия пользования — в{" "}
          <Link className={proseLinkClassName} href="/oferta">
            публичной оферте
          </Link>
          .
        </p>

        <h2 className="type-clause-title">2. Какие данные собираются</h2>
        <p className="type-prose">
          Номер телефона, с которого вы входите и пишете Бро; ваши сообщения и
          файлы в веб-чате, Telegram и iMessage; то, что Бро запоминает о вас
          (факты, предпочтения, правила), расписания и итоги поручений; данные,
          которые вы сами даёте для поручений (имя, адрес, логины и карты в
          зашифрованном сейфе); геопозицию, если вы сами ею поделились (точка,
          место или трансляция в Telegram, карточка геопозиции в iMessage,
          кнопка в веб-чате). Если вы подключили Google, Notion, Slack или
          другие приложения, Бро читает из них только то, что нужно для вашей
          просьбы. Если вы включили звонки или почту Бро, их содержимое тоже
          обрабатывается. Сведения об оплате подписки получает ЮKassa, номер
          карты Исполнитель не видит.
        </p>

        <h2 className="type-clause-title">
          3. Где хранятся данные и кому передаются
        </h2>
        <p className="type-prose">
          Приложение, Бро, база данных (PostgreSQL) и файлы (объектное
          хранилище) работают на серверах Selectel в России. Для работы сервиса
          данные передаются только тем исполнителям, без которых соответствующая
          функция невозможна:
        </p>
        <ul className="type-prose mb-[0.55rem] list-disc pl-6">
          <li>
            RouterAI — языковые модели, которые отвечают на ваши сообщения; для
            моделей DeepSeek запросы обрабатывают хосты DeepInfra и RunInfra.
            Через RouterAI идёт и запасной веб-поиск (поисковики Exa и
            Perplexity).
          </li>
          <li>
            Composio — подключение Google и других приложений, хранение ключей
            доступа к ним, а также веб-поиск: текст запроса уходит поисковикам
            TinyFish и Tavily.
          </li>
          <li>
            МТС Exolve и ElevenLabs — звонки Бро, если вы их включили; записи и
            расшифровки могут храниться у этих провайдеров по их правилам.
          </li>
          <li>AgentMail — собственная почта Бро, если она у вас включена.</li>
          <li>
            Browser Use и 2Captcha, а также резидентный прокси — поручения в
            браузере: они видят страницы, нужные поручению.
          </li>
          <li>
            Supermemory — индекс памяти Бро для поиска по смыслу, если он
            включён.
          </li>
          <li>
            Telegram и Photon (iMessage) — доставка сообщений и кода для входа.
          </li>
          <li>ЮKassa — приём оплаты подписки.</li>
          <li>
            OpenStreetMap — расчёт дороги по адресам и определение адреса по
            присланной геопозиции (уходят только координаты, без имени и
            контактов).
          </li>
          <li>
            Timepad — поиск мероприятий: город, слова поиска и даты, без имени и
            контактов.
          </li>
          <li>
            TypeSafe (модель Jev) — выбор нужных инструментов или модели для
            задания, если он включён: короткий текст сообщения без кодов,
            номеров документов и длинных чисел и прошлый ответ Бро; модель
            возвращает только вероятности и ничего не делает.
          </li>
          <li>
            Mail.ru и Яндекс — личная почта, которую вы подключили (чтение по
            IMAP), и сервисы Яндекса (Еда, Лавка, Go, Маркет), с которыми Бро
            работает через свой браузер от вашего аккаунта.
          </li>
          <li>
            Песочница для кода — изолированная среда на сервере Selectel, где
            Бро запускает программы и обрабатывает файлы, если вы об этом
            просите.
          </li>
        </ul>
        <p className="type-prose">
          Часть этих сервисов находится за пределами России, поэтому ваши данные
          могут передаваться за границу (трансграничная передача). В каких
          странах стоят их серверы, мы не гарантируем. Данные не продаются и не
          используются для рекламы.
        </p>

        <h2 className="type-clause-title">4. Сроки хранения</h2>
        <p className="type-prose">
          Память, расписания, сейф и итоги поручений хранятся, пока вы
          пользуетесь сервисом и не удалили их. Тексты сообщений для связи между
          чатами хранятся 14 дней. Геопозиция, которой вы поделились, хранится
          до 90 дней; просьба «забудь, где я был» удаляет её сразу, но
          присланное в переписке остаётся в истории чатов.
          {transcripts
            ? ` Тексты переписки для отладки хранятся ${String(retentionDays)} дн. (раздел 5).`
            : ""}{" "}
          Стёртые данные ещё до 14 дней могут оставаться в ночных зашифрованных
          резервных копиях базы.
        </p>

        <h2 className="type-clause-title">5. Бета</h2>
        {transcripts ? (
          <p className="type-prose">
            Сервис находится в бете. На время беты владелец сервиса может читать
            вашу переписку с Бро, чтобы находить и чинить ошибки. Для этого
            тексты сообщений хранятся {retentionDays} дн., потом удаляются;
            коды, пароли и ссылки входа из них вырезаются. Метаданные ходов
            (время, длительность, сбои) хранятся отдельно от текстов. Если вы не
            согласны с этим, не пользуйтесь Бро и напишите нам — данные будут
            удалены.
          </p>
        ) : (
          <p className="type-prose">
            Сервис находится в бете. Тексты переписки для владельца сервиса не
            сохраняются; для поиска ошибок хранятся только метаданные ходов
            (время, длительность, сбои).
          </p>
        )}

        <h2 className="type-clause-title">6. Ваши права и удаление данных</h2>
        <p className="type-prose">
          Вы вправе узнать, какие данные о вас хранятся, исправить их и
          потребовать удаления. Память можно стереть, написав Бро «удали всё,
          что ты про меня помнишь», а подключения Google и приложений —
          отключить в чате. Самостоятельного удаления аккаунта в сервисе нет:
          напишите владельцу — мы удалим данные в течение 30 дней, а резервные
          копии базы хранятся до 14 дней:{" "}
          <a className={proseLinkClassName} href={`mailto:${contactEmail}`}>
            {contactEmail}
          </a>
          .
        </p>

        <div className="type-fine mt-[2.6rem] border-t border-border pt-[1.3rem] text-muted-foreground [&_p]:mb-[0.2rem]">
          <p>ИП Соловьев Савелий Андреевич</p>
          <p>ИНН 780159467840 · ОГРНИП 325784700145981</p>
          <p>Email: {contactEmail}</p>
        </div>
      </main>
    </div>
  );
}

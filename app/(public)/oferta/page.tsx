import type { Metadata } from "next";
import { Masthead } from "@web/components/paper/masthead";

export const metadata: Metadata = {
  title: { absolute: "Публичная оферта — bro" },
  description:
    "Условия предоставления доступа к сервису «bro» — персональному ИИ-ассистенту, работающему через iMessage.",
  robots: { index: false },
};

const contactEmail = "solsav1703@gmail.com";

const proseLinkClassName = "underline underline-offset-[0.2em]";

/**
 * Document — paper. Same white, same serif, same rule that chrome is text:
 * a single column of prose divided by hairlines, no cards, no radius, no
 * shadow. The wording is a legal text and is carried over verbatim.
 */
export default function Page() {
  return (
    <div className="flex min-h-svh flex-col">
      <Masthead />

      <main className="mx-auto w-full max-w-[44rem] px-bro-pad pt-[0.6rem] pb-20 [&_h2]:mt-8 [&_h2]:mb-2 [&_p]:mb-[0.55rem]">
        <h1 className="type-doc-heading mb-[0.35rem]">Публичная оферта</h1>
        <p className="type-fine mb-8 text-muted-foreground">
          о предоставлении доступа к сервису «bro» · редакция от 27.08.2026
        </p>

        <h2 className="type-clause-title">1. Общие положения</h2>
        <p className="type-prose">
          1.1. Настоящий документ является публичной офертой ИП Соловьева
          Савелия Андреевича (далее — «Исполнитель») и содержит условия
          предоставления доступа к сервису «bro» — персональному ИИ-ассистенту,
          работающему через iMessage (далее — «Сервис»), размещённому по адресу{" "}
          <a className={proseLinkClassName} href="https://brobro.tech">
            brobro.tech
          </a>
          .
        </p>
        <p className="type-prose">
          1.2. Оплата доступа к Сервису означает полное и безоговорочное
          принятие условий настоящей оферты (акцепт) в соответствии со ст. 438
          ГК РФ. Лицо, оплатившее доступ, далее именуется «Пользователь».
        </p>

        <h2 className="type-clause-title">2. Предмет</h2>
        <p className="type-prose">
          2.1. Исполнитель предоставляет Пользователю доступ к функциям Сервиса:
          обработка запросов в переписке iMessage, выполнение поручений (поиск
          информации, задачи в браузере, напоминания, уведомления), в объёме
          выбранного тарифа.
        </p>
        <p className="type-prose">
          2.2. Тарифы и их наполнение опубликованы на странице{" "}
          <a className={proseLinkClassName} href="https://brobro.tech/#pricing">
            brobro.tech/#pricing
          </a>
          . Платный тариф «Полный доступ» — 2000 ₽ за 30 календарных дней. Тариф
          не продлевается автоматически.
        </p>

        <h2 className="type-clause-title">
          3. Порядок оплаты и предоставления доступа
        </h2>
        <p className="type-prose">
          3.1. Оплата производится банковской картой или иным способом через
          сервис ЮKassa (ООО НКО «ЮМани»). Кассовый чек направляется в
          электронном виде.
        </p>
        <p className="type-prose">
          3.2. Доступ по платному тарифу включается автоматически в течение
          нескольких минут после подтверждения оплаты и действует 30 календарных
          дней с момента включения.
        </p>
        <p className="type-prose">
          3.3. Услуга оказывается дистанционно, доставка не требуется: Сервис
          работает в существующей переписке Пользователя с номером Сервиса в
          iMessage.
        </p>

        <h2 className="type-clause-title">4. Возвраты</h2>
        <p className="type-prose">
          4.1. Если доступ по платному тарифу не был включён после оплаты, либо
          Сервис недоступен по вине Исполнителя, Пользователь вправе потребовать
          возврат оплаты, написав на{" "}
          <a className={proseLinkClassName} href={`mailto:${contactEmail}`}>
            {contactEmail}
          </a>
          .
        </p>
        <p className="type-prose">
          4.2. Возврат осуществляется тем же способом, которым была произведена
          оплата, в срок до 10 рабочих дней.
        </p>

        <h2 className="type-clause-title">5. Ограничения и ответственность</h2>
        <p className="type-prose">
          5.1. Сервис использует технологии искусственного интеллекта; ответы
          могут содержать неточности. Сервис не предназначен для получения
          профессиональных медицинских, юридических или финансовых консультаций.
        </p>
        <p className="type-prose">
          5.2. Исполнитель не несёт ответственности за недоступность Сервиса по
          причинам, не зависящим от него (сбои операторов связи, платформ Apple,
          поставщиков инфраструктуры), но обязуется устранять сбои в разумный
          срок.
        </p>
        <p className="type-prose">
          5.3. Пользователь обязуется не использовать Сервис для противоправных
          действий.
        </p>

        <h2 className="type-clause-title">6. Персональные данные</h2>
        <p className="type-prose">
          6.1. Исполнитель обрабатывает персональные данные Пользователя (номер
          телефона, содержимое переписки, данные подключённых Пользователем
          сервисов) исключительно для оказания услуги, в соответствии с 152-ФЗ
          «О персональных данных». Данные не передаются третьим лицам, кроме
          случаев, необходимых для работы Сервиса (обработка платежей,
          инфраструктура) или предусмотренных законом.
        </p>

        <h2 className="type-clause-title">7. Прочее</h2>
        <p className="type-prose">
          7.1. Исполнитель вправе изменять условия оферты; новая редакция
          публикуется на этой странице и применяется к оплатам, совершённым
          после публикации.
        </p>
        <p className="type-prose">
          7.2. По вопросам работы Сервиса:{" "}
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

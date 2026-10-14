import Image from "next/image";
import Link from "next/link";
import { Brain, Clock3, Globe, Mail, Phone, ShieldCheck } from "lucide-react";
import { cn } from "@web/components/class-names";
import { Card } from "@web/components/ui/card";
import { LandingFaq } from "./landing-faq";
import { LandingWalkthrough } from "./landing-walkthrough";
import { WriteBro } from "./write-bro";
import { RequestRail } from "./request-rail";
import styles from "../landing.module.css";

const features = [
  {
    title: "Руки в интернете",
    description:
      "Найти нужное, сравнить варианты, разобраться с сайтом. Поручение начинается с обычного сообщения.",
    icon: Globe,
    color: styles.blue,
    portraits: ["s07", "s08", "s09"],
  },
  {
    title: "Свой номер",
    description:
      "Когда для дела нужен разговор, bro может позвонить. Задачу и детали вы обсуждаете в переписке.",
    icon: Phone,
    color: styles.yellow,
    portraits: ["s04"],
  },
  {
    title: "Память о важном",
    description:
      "Предпочтения, факты и ваши правила помогают bro учитывать контекст следующих поручений.",
    icon: Brain,
    color: styles.pink,
  },
  {
    title: "Дела по расписанию",
    description:
      "Напоминания и повторяющиеся поручения — чтобы не держать каждую мелочь в голове.",
    icon: Clock3,
    color: styles.coral,
    portraits: ["s11"],
  },
  {
    title: "Почта под рукой",
    description:
      "Подключённые почтовые аккаунты доступны bro для работы с письмами по вашим поручениям.",
    icon: Mail,
    color: styles.yellow,
  },
  {
    title: "Отдельный Сейф",
    description:
      "Сохранённые карты и доступы к сайтам собраны в своём разделе. Управлять ими можно из кабинета.",
    icon: ShieldCheck,
    color: styles.blue,
  },
];
const requests = [
  {
    portrait: "s02",
    text: "Найди стоматологию рядом со мной и узнай, есть ли время в пятницу после работы.",
    category: "Здоровье и запись",
  },
  {
    portrait: "s06",
    text: "Подбери ресторан на вечер: тихое место, столик на двоих и недалеко от метро.",
    category: "Планы на вечер",
  },
  {
    portrait: "s11",
    text: "Напомни завтра взять форму на тренировку. Лучше утром, пока я ещё дома.",
    category: "Повседневные мелочи",
  },
  {
    portrait: "s12",
    text: "Сравни варианты доставки для дачи и собери самое важное в короткий список.",
    category: "Покупки и поиск",
  },
];

function Portrait({
  id,
  size = 120,
}: {
  readonly id: string;
  readonly size?: number;
}) {
  return (
    <Image
      alt=""
      aria-hidden="true"
      height={size}
      src={`/brand/portraits/${id}-bro-portrait.webp`}
      unoptimized
      width={size}
    />
  );
}

export function LandingStory({
  phoneNumber,
  fontClassName,
}: {
  readonly phoneNumber?: string;
  readonly fontClassName: string;
}) {
  return (
    <div className={styles.story}>
      <section
        className={cn(styles.section, styles.introduction)}
        id="meet-bro"
      >
        <p className={styles.eyebrow}>Знакомьтесь, bro</p>
        <h2 className={cn("type-section-title", styles.editorialTitle)}>
          Планы — в сообщении.
          <span className={styles.inlinePortrait}>
            <Portrait id="s08" />
          </span>{" "}
          Дела — у bro.
        </h2>
        <p className={styles.introCopy}>
          Свой номер, своя память, свои руки в интернете. Записать к врачу,
          забронировать, заказать — просто напиши ему.
        </p>
        <div aria-hidden="true" className={styles.introPortrait}>
          <Portrait id="s10" size={220} />
        </div>
      </section>

      <section
        className={cn(styles.section, styles.demoSection)}
        id="how-it-works"
      >
        <div className={styles.demoCopy}>
          <p className={styles.eyebrow}>Как это работает</p>
          <h2 className="type-section-title">Одно сообщение. Всё дело.</h2>
          <p>
            Не нужно искать правильную кнопку или заполнять новую форму.
            Расскажи, что хочешь сделать. bro уточнит детали и вернётся с
            результатом в ту же переписку.
          </p>
          <Portrait id="s01" size={180} />
        </div>
        <div className={styles.chatExample}>
          <div className={styles.chatHeader}>
            <span className={styles.chatLogo}>bro.</span>
            <span>Пример переписки</span>
          </div>
          <div className={styles.chatBody}>
            <div className={styles.chatMessage}>
              <span className={styles.sender}>Вы</span>
              <p>Хочу записаться к стоматологу в пятницу после работы.</p>
            </div>
            <div className={styles.chatMessage}>
              <span className={styles.sender}>bro</span>
              <p>В каком районе искать и во сколько ты освобождаешься?</p>
            </div>
            <div className={styles.taskCard}>
              <span className={styles.taskLabel}>План поручения</span>
              <h3 className="type-card-title">Найти удобное время</h3>
              <ul>
                <li>Уточнить район и пожелания</li>
                <li>Найти варианты и узнать условия</li>
                <li>Вернуться к вам с результатом</li>
              </ul>
            </div>
            <div className={styles.chatMessage}>
              <span className={styles.sender}>Вы</span>
              <p>Рядом с домом. После семи будет удобно.</p>
            </div>
          </div>
          <p className={styles.exampleCaption}>
            Иллюстрация сценария, не реальная переписка.
          </p>
        </div>
      </section>

      <section className={cn(styles.section, styles.coordinationSection)}>
        <div className={styles.coordinationHeading}>
          <p className={styles.eyebrow}>Больше, чем ответ</p>
          <h2 className="type-section-title">
            Ты объясняешь задачу.
            <br />
            bro разбирается с шагами.
          </h2>
        </div>
        <div className={styles.coordinationGrid}>
          <div className={styles.chatExample}>
            <div className={styles.chatHeader}>
              <span className={styles.chatLogo}>bro.</span>
              <span>Пример поручения</span>
            </div>
            <div className={styles.chatBody}>
              <div className={styles.chatMessage}>
                <span className={styles.sender}>Вы</span>
                <p>Помоги организовать ужин на двоих в субботу.</p>
              </div>
              <div className={styles.chatMessage}>
                <span className={styles.sender}>bro</span>
                <p>Уточним время, район и кухню. Потом найду варианты.</p>
              </div>
            </div>
          </div>
          <span aria-hidden="true" className={styles.coordinationConnector}>
            →
          </span>
          <div className={styles.taskOutputs}>
            <div className={styles.delegatedTask}>
              <Globe aria-hidden="true" size={24} />
              <div>
                <strong>Найти место</strong>
                <span>Сравнить подходящие варианты</span>
              </div>
              <span className={styles.statusDot} />
            </div>
            <div className={styles.delegatedTask}>
              <Phone aria-hidden="true" size={24} />
              <div>
                <strong>Уточнить детали</strong>
                <span>Проверить время и условия</span>
              </div>
              <span className={styles.statusDot} />
            </div>
          </div>
        </div>
        <p className={styles.coordinationSummary}>
          Поиск, сайты, звонки и напоминания — разные шаги одной задачи. А для
          тебя это один разговор с bro.
        </p>
      </section>

      <section className={cn(styles.section, styles.walkthroughSection)}>
        <LandingWalkthrough fontClassName={fontClassName} />
      </section>

      <section className={cn(styles.section, styles.valuesSection)}>
        <p className={styles.eyebrow}>Почему личный агент</p>
        <div className={styles.valuesGrid}>
          <article>
            <Portrait id="s03" size={112} />
            <h2 className="type-section-title">Пиши как своему.</h2>
            <p>
              Обычными словами, без специального языка команд. Начни с того, что
              у тебя на уме.
            </p>
          </article>
          <article>
            <Portrait id="s09" size={112} />
            <h2 className="type-section-title">Контекст остаётся.</h2>
            <p>
              У bro есть память о фактах, предпочтениях и правилах, которые
              помогают в следующих разговорах.
            </p>
          </article>
          <article>
            <Portrait id="s07" size={112} />
            <h2 className="type-section-title">Дела — рядом.</h2>
            <p>
              Переписка с bro, кабинет и Сейф связаны с одним личным помощником,
              а не с очередной формой на сайте.
            </p>
          </article>
        </div>
      </section>

      <section
        className={cn(styles.section, styles.featuresSection)}
        id="features"
      >
        <p className={styles.eyebrow}>Что у bro под рукой</p>
        <h2 className={cn("type-section-title", styles.featureHeading)}>
          Привычная переписка.
          <br />
          Настоящие инструменты.
        </h2>
        <div className={styles.featuresGrid}>
          {features.map(
            ({
              title: featureTitle,
              description,
              icon: Icon,
              color,
              portraits,
            }) => (
              <Card
                className={cn(styles.featureCard, color)}
                key={featureTitle}
              >
                {portraits ? (
                  <div className={styles.featureArt}>
                    {portraits.map((portrait) => (
                      <Portrait id={portrait} key={portrait} size={180} />
                    ))}
                  </div>
                ) : (
                  <Icon aria-hidden="true" className={styles.featureIcon} />
                )}
                <h3 className="type-card-title">{featureTitle}</h3>
                <p>{description}</p>
              </Card>
            )
          )}
        </div>
      </section>

      <section
        aria-label="Примеры повседневных задач"
        className={styles.taskStrip}
      >
        <p className={styles.eyebrow}>Большие планы. Маленькие дела.</p>
        <p className={styles.taskWords}>
          Найти. Записаться. Забронировать. Напомнить. Разобраться.
        </p>
      </section>

      <section className={cn(styles.section, styles.requestsSection)}>
        <p className={styles.eyebrow}>С чего начнём?</p>
        <h2 className="type-section-title">У каждого свои дела.</h2>
        <p className={styles.sectionDescription}>
          Несколько примеров того, о чём можно попросить bro.
        </p>
        <RequestRail>
          {requests.map((request) => (
            <article className={styles.requestCard} key={request.category}>
              <p className={styles.requestText}>«{request.text}»</p>
              <div className={styles.requestAuthor}>
                <Portrait id={request.portrait} size={64} />
                <span>{request.category}</span>
              </div>
            </article>
          ))}
        </RequestRail>
        <p className={styles.exampleCaption}>
          Это примеры запросов, а не отзывы или сообщения пользователей.
        </p>
      </section>

      <section className={cn(styles.section, styles.faqSection)} id="questions">
        <div>
          <p className={styles.eyebrow}>Вопросы</p>
          <h2 className={cn("type-section-title", styles.faqHeading)}>
            По делу.
            <br />
            Без загадок.
          </h2>
          <Portrait id="s12" size={220} />
        </div>
        <LandingFaq />
      </section>

      <section className={cn(styles.section, styles.finalSection)}>
        <div className={styles.finalCta}>
          <Portrait id="s05" size={128} />
          <h2 className="type-section-title">Есть дело? Напиши bro.</h2>
          <p>
            {phoneNumber
              ? "Начни с простого «Привет» в iMessage."
              : "iMessage пока недоступен. Кабинет и Сейф — по ссылкам ниже."}
          </p>
          <WriteBro phoneNumber={phoneNumber} />
          <Link className={styles.finalCabinet} href="/sign-in">
            Открыть кабинет
          </Link>
        </div>
      </section>
    </div>
  );
}

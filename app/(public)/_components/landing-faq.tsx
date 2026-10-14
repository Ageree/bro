"use client";

import { useState } from "react";
import Link from "next/link";
import { Plus } from "lucide-react";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@web/components/ui/collapsible";
import styles from "../landing.module.css";

const questions = [
  {
    question: "Что такое bro?",
    answer:
      "Личный ИИ-агент, которому можно написать с поручением. У него есть память, свой номер и инструменты для работы в интернете.",
  },
  {
    question: "Где с ним общаться?",
    answer:
      "Кнопка «Написать бро» открывает iMessage с приветствием. Если номер сервиса на этом деплое не настроен, кнопка честно покажет «Пока закрыто».",
  },
  {
    question: "Сколько это стоит?",
    answer: (
      <>
        Актуальные условия доступа и оплаты опубликованы в{" "}
        <Link href="/oferta">Оферте</Link>. Сверься с ней перед началом: лендинг
        не заменяет условия сервиса.
      </>
    ),
  },
  {
    question: "Что можно поручить bro?",
    answer:
      "Например, найти варианты, разобраться с сайтом, помочь с записью или бронированием, поставить напоминание. Доступность отдельных действий зависит от подключённых сервисов и деталей задачи.",
  },
  {
    question: "Что происходит с моими данными?",
    answer: (
      <>
        Сообщения, файлы и данные подключённых аккаунтов обрабатываются для
        работы сервиса. Что хранится, кому передаётся и как запросить удаление —
        в <Link href="/privacy">политике конфиденциальности</Link>.
      </>
    ),
  },
  {
    question: "Для чего кабинет и Сейф?",
    answer: (
      <>
        <Link href="/sign-in">Кабинет</Link> — для управления своим bro и
        подключениями. <Link href="/vault">Сейф</Link> — отдельный раздел для
        сохранённых карт и доступов к сайтам.
      </>
    ),
  },
];

export function LandingFaq() {
  const [active, setActive] = useState<number | null>(0);
  return (
    <div className={styles.faqList}>
      {questions.map((item, index) => (
        <Collapsible
          className={styles.faqItem}
          key={item.question}
          onOpenChange={(open) => {
            setActive(open ? index : null);
          }}
          open={active === index}
        >
          <CollapsibleTrigger className={styles.faqTrigger}>
            <span className={styles.faqNumber}>
              {String(index + 1).padStart(2, "0")}
            </span>
            <span className={styles.faqQuestion}>{item.question}</span>
            <Plus aria-hidden="true" className={styles.faqPlus} size={20} />
          </CollapsibleTrigger>
          <CollapsibleContent className={styles.faqAnswer}>
            <p>{item.answer}</p>
          </CollapsibleContent>
        </Collapsible>
      ))}
    </div>
  );
}

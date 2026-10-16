import type { RouterQuestion } from "@agent/lib/tool-router/questions";

/**
 * The blocks of the task agent's file kit lines beside their core
 * (`agent/subagents/task/instructions/content/kit/`): forms and signing,
 * sums and payment documents, office files, scans and photos, data. Each is
 * named after its file there.
 */
export const kitBlocks = ["forms", "money", "office", "scans", "data"] as const;

export type KitBlock = (typeof kitBlocks)[number];

/**
 * One `noul` question per block about Bro's job for the task agent (its
 * `task` message), each named after its block. A changed word needs a new
 * measurement and thresholds ({@link kitThresholds}).
 */
export const kitQuestions = {
  forms: {
    type: "noul",
    instructions:
      "Нужно ли в этом задании заполнить готовый бланк или форму — вписать данные в PDF, скан бланка, анкету, заявление, согласие, договор или расчёт — или отметить места подписи?",
    criteria: {
      true: "Заполнить PDF-бланк, анкету, заявление (на отпуск, о справке), согласие, договор, налоговый бланк; вписать данные поверх скана, поставить галочки в клетки; отметить, где человеку расписаться; подготовить документ к подписи.",
      false:
        "Сделать новый документ с нуля, презентацию, таблицу, перевод, скан из фото, фото на документы, разбор выписки — без чужого бланка.",
    },
  },
  money: {
    type: "noul",
    instructions:
      "Есть ли в задании деньги в документах: счёт, акт, смета или чеки с суммами, банковская выписка, акт сверки, авансовый отчёт, возмещение, налоговый вычет, пакет документов на визу или QR-код для оплаты?",
    criteria: {
      true: "Сверить суммы в таблице счёта, акта, сметы или чека; разобрать выписку банка или выгрузку операций; собрать чеки или документы одного дела (командировка, вычет, виза) в таблицу или один PDF; сделать счёт на оплату или QR для оплаты.",
      false:
        "Документы без сумм, презентация, перевод, фото на документы, календарь, контакты.",
    },
  },
  office: {
    type: "noul",
    instructions:
      "Нужно ли сделать, заполнить или изменить файл Word, Excel или CSV, презентацию, или перевести документ с сохранением его вида?",
    criteria: {
      true: "Заполнить шаблон Word, правки в режиме рецензирования, сравнить версии договора; таблица Excel с формулами, датами, суммами или графиком; разобрать CSV; презентация или слайды; перевод PDF или Word с тем же видом; перепечатать документ в Word.",
      false:
        "Только PDF-бланк, скан из фото, фото на документы, архив, файл календаря .ics или контактов .vcf без таблицы.",
    },
  },
  scans: {
    type: "noul",
    instructions:
      "Нужно ли работать с фото или сканами страниц как с картинками: сделать ровный скан или один PDF из фото, фото на документы, закрасить данные на скане, разобрать сканы по страницам или распаковать архив ZIP?",
    criteria: {
      true: "Фото страниц или чеков в ровный скан или один PDF; фото на паспорт, визу, 3×4; закрасить номер или прописку на скане или фото; повернуть, переставить, убрать дубли страниц сканов; сжать PDF со сканами до лимита; распаковать и разобрать ZIP.",
      false:
        "Заполнить бланк без фото, презентация, таблица, перевод, перепечатка текста с одного фото в Word.",
    },
  },
  data: {
    type: "noul",
    instructions:
      "Нужно ли привести данные к одному виду (телефоны, даты, суммы, имена, кодировка), сделать файл календаря .ics или контактов .vcf, читаемый PDF или Word из XML, JSON или выгрузки, или разобраться с электронной подписью (.sig, .p7s)?",
    criteria: {
      true: "Нормализовать телефоны, даты, суммы или имена в списке; контакты в .vcf; расписание в календарь .ics; выписка ЕГРН или другой XML в PDF; файл подписи .sig или .p7s; грязная таблица с разными форматами дат и чисел.",
      false:
        "Заполнить бланк, презентация, скан из фото, фото на документы, перевод.",
    },
  },
} as const satisfies Readonly<Record<KitBlock, RouterQuestion>>;

/**
 * The least probability of «yes» that brings a block in, by the model the
 * answer names (never the one asked for, as the tool router's thresholds):
 * `first`, for the job that opens the session; `more`, for a later message,
 * which only adds blocks and re-reads the session's history uncached when
 * it does.
 *
 * Measured on 16.10 with these questions, word for word: Bro's own `task`
 * messages from three runs of the files bench (`docs/benchmarks/files/`, 38
 * jobs of 28 cases and 4 later messages; the texts carry test personas and
 * stay out of the repository), with the blocks each job needs labelled by
 * hand, and 10 short jobs written for the check. The lowest probability of
 * a needed block was 0.66 with both models (Jev 1.13 on RouterAI: a ZIP
 * archive's `scans`; Jev 1.14 on TypeSafe: a timetable's `office`); at 0.2
 * every needed block of every job came in (recall 52 of 52), with precision
 * 52 of 62 (1.13) and 52 of 63 (1.14), 1.97 of the 5 blocks a job. The
 * short jobs' needed blocks were at least 0.94 (1.13). A later message only
 * restated the job («пришли ссылку на файл») and reached 0.51 at most for a
 * block not chosen yet, so `more` is 0.6. Jev answered in 0.93 s at p50 and
 * 1.39 s at most on RouterAI, 0.21 s and 0.48 s on TypeSafe (from a cloud
 * session, not the VM).
 */
export const kitThresholds = {
  "jev-1.14.0": { first: 0.2, more: 0.6 },
  "typesafe/jev-1.13-20260917": { first: 0.2, more: 0.6 },
} as const satisfies Readonly<
  Record<string, { readonly first: number; readonly more: number }>
>;

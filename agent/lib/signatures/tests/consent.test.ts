import type { ModelMessage } from "ai";
import { describe, expect, it, vi } from "vitest";

// Share links are signed with the sandbox key, read when the modules load.
vi.stubEnv("SANDBOX_SIGNING_KEY", "33".repeat(32));
const { signAnswer } = await import("@agent/lib/browser-use/said");
const {
  asksToSign,
  deliveredShareIds,
  deliveryVerdicts,
  signRequest,
  signaturePhotoCandidates,
} = await import("@agent/lib/signatures/consent");
const { sandboxFileLinkSignature } = await import("@agent/lib/sandbox/keys");

const shareId = "a1".repeat(12);

function shareLink(id = shareId, name = "anketa.pdf") {
  return `https://example.com/eve/v1/sandbox-files/${id}/${name}?sig=${sandboxFileLinkSignature(`sandbox/files/${id}/${name}`)}`;
}

function staged(path: string, mediaType: string) {
  const url = new URL("eve-sandbox:");
  url.searchParams.set("path", path);
  url.searchParams.set("size", "1000");
  url.searchParams.set("type", mediaType);
  return { data: url, mediaType, type: "file" as const };
}

function person(text: string, files: ReturnType<typeof staged>[] = []) {
  return Object.assign(
    {
      content: [{ text, type: "text" as const }, ...files],
      role: "user" as const,
    },
    { kind: "user" }
  ) satisfies ModelMessage;
}

const photo = (name: string) =>
  staged(`/workspace/attachments/0123456789abcdef/${name}`, "image/jpeg");

/** Bro's send of one file, as the history keeps it. */
function sent(
  input: {
    readonly attachments: readonly { kind: "file"; url: string }[];
    readonly kind?: "message";
  },
  delivered = true
): ModelMessage[] {
  return [
    {
      content: [
        {
          input,
          toolCallId: "send-1",
          toolName: "send_message",
          type: "tool-call",
        },
      ],
      role: "assistant",
    },
    {
      content: [
        {
          output: {
            type: "json",
            value: delivered ? { status: "sent" } : { status: "failed" },
          },
          toolCallId: "send-1",
          toolName: "send_message",
          type: "tool-result",
        },
      ],
      role: "tool",
    },
  ];
}

const question =
  "Ставлю твою сохранённую подпись на «anketa.pdf»: подпись — стр. 1 и 2. Это картинка подписи, а не электронная подпись (КЭП). Подписываю?";
const row = {
  id: "1f6f5d78-641b-4c80-aacf-eec05af14e53",
  question,
  sourceShareId: shareId,
};

/** What one send did to the open signings (by default, the one above). */
function verdicts(
  message: Parameters<typeof deliveryVerdicts>[1],
  rows: Parameters<typeof deliveryVerdicts>[0] = [row]
) {
  return deliveryVerdicts(rows, message);
}

const asked = (text: string) => verdicts({ kind: "message", text })[0]?.asked;

describe("the person's answer to the signing question", () => {
  it("is yes only when it is nothing but a yes", () => {
    for (const yes of [
      "да",
      "да, подписывай",
      "подписывай",
      "ок",
      "хорошо, подписывай",
      "согласен",
      "давай",
    ]) {
      expect(signAnswer([yes])).toBe("yes");
    }
    expect(signAnswer(["да, но дату вчерашнюю"])).toBeUndefined();
    expect(signAnswer(["👍"])).toBeUndefined();
  });

  it("is no for a refusal, and for signing it themselves", () => {
    expect(signAnswer(["не подписывай"])).toBe("no");
    expect(signAnswer(["нет, подпишу сам ручкой"])).toBe("no");
  });
});

describe("the person's own request to sign", () => {
  it.each([
    ["Заполни анкету и подпиши", true],
    ["распишись за меня", true],
    ["можешь подписать за меня?", true],
    ["не забудь подписать", true],
    ["поставь мою подпись и дату", true],
    ["моей сохранённой подписью, пожалуйста", true],
    ["Подпись моя на фотке, если нужна", true],
    ["fill it in and sign it", true],
    ["put my signature on page 2", true],
    ["не подписывай", false],
    ["пришли без подписи", false],
    ["Заполни анкету, подпишу сам", false],
    ["сама распишусь ручкой", false],
    ["подпись тут не нужна", false],
    ["поставь подпись мужа", false],
    ["подпишись на рассылку", false],
    ["Вот бланк\n[файл: Подпишите и верните.pdf (application/pdf)]", false],
    ["моя подпись уже стоит на первой странице", false],
    ["I'll sign it myself", false],
    ["sign up on the site", false],
    ["Заполни анкету", false],
    // Someone else's words, quoted.
    [
      "Вот что пишет хозяин: «Подпишите договор и верните». Что думаешь?",
      false,
    ],
    ['He wrote: "Sign it and send it back". Thoughts?', false],
    ["> Подпишите и верните\nчто скажешь?", false],
    // They want to see it first.
    ["Сначала пришли посмотреть, потом подпиши", false],
    ["подпиши, но сначала покажи мне", false],
    ["Скинь, я гляну, потом подпишешь", false],
    ["Заполни анкету, потом подпиши", true],
    // Whether Bro can, and a request about the document at hand.
    ["Можешь подписать такие документы?", false],
    ["Можешь подписать его?", true],
    // A signature to keep, and one to sign with.
    ["Вот моя подпись, сохрани, пригодится", false],
    ["Сохрани мою подпись на фото", false],
    ["Вот моя подпись, сохрани её и подпиши анкету", true],
    // For someone else.
    ["Подпиши за маму, она разрешила", false],
    ["поставь подпись директора", false],
    ["Sign the lease for my wife", false],
    ["Sign it with John's signature", false],
    ["распишись за него", false],
    ["Подпиши от имени мужа", false],
    ["Подпиши вместо мужа", false],
    ["Подпиши договор от лица директора", false],
    ["Подпиши договор за него", false],
    ["Sign it as my husband", false],
    ["Please sign the lease as my landlord requested", true],
    ["Sign it on his behalf", false],
    ["Here's my signature, sign it", true],
    ["Подпиши договор, деньги за него я перевёл", true],
    // A parent signs their child's papers with their own signature.
    ["Подпиши согласие за сына", true],
    ["Подпиши заявление за дочь, я её мама", true],
    ["Fill in the consent form for my son and sign it", true],
  ])("«%s» asks to sign: %s", (text, asks) => {
    expect(asksToSign(text)).toBe(asks);
  });

  it("takes «Сможешь подписать?» for a request only with the document in the same messages", () => {
    expect(asksToSign("Сможешь подписать?")).toBe(false);
    expect(asksToSign("Сможешь подписать?", true)).toBe(true);
    expect(asksToSign("Сможешь подписать такие документы?", true)).toBe(false);
  });

  it("is read from their newest messages only, never from a report", () => {
    const reply: ModelMessage = { content: "Готово.", role: "assistant" };
    const report = Object.assign(
      {
        content: "Background task task_1 (task) is completed.\n\nПодпиши её.",
        role: "user" as const,
      },
      { kind: "execution.background_task" }
    );
    expect(
      signRequest([person("Заполни анкету"), person("и подпиши")])
    ).toMatchObject({ kind: "asks", words: "и подпиши" });
    expect(signRequest([person("подпиши"), reply, person("спасибо")])).toBe(
      null
    );
    expect(signRequest([person("Заполни анкету"), report])).toBe(null);
  });

  it("is no request when their newest message asks a question of its own about text sent before it", () => {
    expect(
      signRequest([
        person("Подпишите, пожалуйста, договор и пришлите обратно до пятницы."),
        person("Что думаешь по договору? Всё норм?"),
      ])
    ).toBe(null);
    expect(
      signRequest([
        person("Вот договор", [
          staged(
            "/workspace/attachments/fedcba9876543210/dogovor.pdf",
            "application/pdf"
          ),
        ]),
        person("Можешь подписать его?"),
      ])
    ).toMatchObject({ kind: "asks" });
    expect(
      signRequest([
        person(
          "Добрый день! Подпишите, пожалуйста, договор и пришлите обратно до пятницы.\nЧто думаешь по договору? Всё норм?"
        ),
      ])
    ).toBe(null);
    expect(signRequest([person("Заполни и подпиши, ок?")])).toMatchObject({
      kind: "asks",
    });
  });

  it("does not sign at once a document whose report came into the person's turn before they saw it", () => {
    const gaveTask = (taskId: string): ModelMessage[] => [
      {
        content: [
          {
            input: { message: "Заполни заявление" },
            toolCallId: `call-${taskId}`,
            toolName: "task",
            type: "tool-call",
          },
        ],
        role: "assistant",
      },
      {
        content: [
          {
            output: {
              type: "json",
              value: { agentId: `ag_${taskId}`, status: "working", taskId },
            },
            toolCallId: `call-${taskId}`,
            toolName: "task",
            type: "tool-result",
          },
        ],
        role: "tool",
      },
    ];
    const reportOf = (taskId: string) =>
      Object.assign(
        {
          content: `Background task ${taskId} (task) is completed.\n\nГотово.`,
          role: "user" as const,
        },
        { kind: "execution.background_task" }
      ) satisfies ModelMessage;
    const reply = sent({ attachments: [] });
    const before = [
      person("Заполни заявление"),
      ...gaveTask("task_a"),
      ...reply,
      reportOf("task_a"),
    ];
    expect(signRequest([...before, person("И анкету заполни и подпиши")])).toBe(
      null
    );
    expect(
      signRequest([...before, ...reply, person("Подпиши его")])
    ).toMatchObject({ kind: "asks" });
  });

  it("tells a request for someone else apart, to refuse it", () => {
    expect(signRequest([person("Подпиши за мужа")])).toEqual({
      kind: "someone_else",
    });
  });

  it("keys each request apart, the same words in a later message too", () => {
    const reply: ModelMessage = { content: "Готово.", role: "assistant" };
    const first = signRequest([person("подпиши")]);
    const again = signRequest([person("подпиши"), reply, person("подпиши")]);
    expect(first).toMatchObject({ kind: "asks" });
    expect(again).toMatchObject({ kind: "asks" });
    expect(first).not.toEqual(again);
  });
});

describe("what a delivered send did to an open signing", () => {
  it("asked the stored question word for word, with a line before and after", () => {
    const text = `Вот анкета.\n${question}\nОтветь «да» или «нет».`;
    expect(verdicts({ kind: "message", text })).toEqual([
      { asked: { text, verbatim: true }, id: row.id, shown: false },
    ]);
  });

  it("asked in its own words when it ends by asking to sign", () => {
    const text = "Поставлю подпись на анкету, стр. 1 и 2. Подписываю?";
    expect(asked(text)).toEqual({ text, verbatim: false });
  });

  it("reads a link's own «?» as no question", () => {
    expect(asked(`${question}\nФайл: ${shareLink()}`)).toEqual({
      text: `${question}\nФайл: ${shareLink()}`,
      verbatim: true,
    });
    expect(asked(`Вот файл: [анкета](${shareLink()})`)).toBeUndefined();
  });

  it("clears what was asked with another question, even one after the stored question", () => {
    expect(asked("Что-то ещё?")).toBe("clear");
    expect(
      asked(`${question}\nИли сначала показать анкету юристу? Файл ниже.`)
    ).toBe("clear");
  });

  it("asks only the offer whose stored question it is", () => {
    const other = {
      id: "2f6f5d78-641b-4c80-aacf-eec05af14e53",
      question: question.replace("anketa.pdf", "zayavlenie.pdf"),
      sourceShareId: null,
    };
    expect(
      verdicts({ kind: "message", text: question }, [row, other]).map(
        (verdict) => verdict.asked
      )
    ).toEqual([{ text: question, verbatim: true }, "clear"]);
  });

  it("asks one of two offers sharing a question only by the file the message carries", () => {
    const corrected = {
      id: "3f6f5d78-641b-4c80-aacf-eec05af14e53",
      question,
      sourceShareId: "b2".repeat(12),
    };
    const askedOf = (message: Parameters<typeof deliveryVerdicts>[1]) =>
      verdicts(message, [row, corrected]).map((verdict) => verdict.asked);
    expect(askedOf({ kind: "message", text: question })).toEqual([
      "clear",
      "clear",
    ]);
    expect(
      askedOf({
        attachments: [{ kind: "file", url: shareLink("b2".repeat(12)) }],
        kind: "message",
        text: question,
      })
    ).toEqual(["clear", { text: question, verbatim: true }]);
  });

  it("showed the unsigned file when it carried its link, a name with parentheses in the text too", () => {
    expect(
      verdicts({
        attachments: [{ kind: "file", url: shareLink() }],
        kind: "message",
      })[0]?.shown
    ).toBe(true);
    const duplicate = shareLink(shareId, "anketa(1).pdf");
    expect(
      verdicts({ kind: "message", text: `Вот [анкета](${duplicate}).` })[0]
        ?.shown
    ).toBe(true);
  });

  it("counts a link the model mangled as the file it stands for", () => {
    const known = [shareLink()];
    const mangled = shareLink().replace(/sig=.*$/u, "sig=broken");
    expect(
      deliveredShareIds(
        sent({
          attachments: [{ kind: "file", url: mangled }],
          kind: "message",
        }),
        known
      )
    ).toEqual([shareId]);
    expect(
      deliveredShareIds(
        sent({ attachments: [{ kind: "file", url: mangled }] }, false),
        known
      )
    ).toEqual([]);
  });
});

describe("photos a signing may take the person's signature from", () => {
  it("takes the photo of a message that says the signature is theirs", () => {
    expect(
      signaturePhotoCandidates([
        person("Подпись моя на фотке, если нужна.", [
          staged(
            "/workspace/attachments/fedcba9876543210/anketa.pdf",
            "application/pdf"
          ),
          photo("IMG_1.jpg"),
        ]),
      ])
    ).toEqual(["/workspace/attachments/0123456789abcdef/IMG_1.jpg"]);
  });

  it("takes the photo that came as the next message after the words, not after Bro's reply", () => {
    const words = person("Заполни анкету и подпиши, подпись моя на фото", [
      staged(
        "/workspace/attachments/fedcba9876543210/anketa.pdf",
        "application/pdf"
      ),
    ]);
    expect(
      signaturePhotoCandidates([words, person("", [photo("IMG_1.jpg")])])
    ).toEqual(["/workspace/attachments/0123456789abcdef/IMG_1.jpg"]);
    expect(
      signaturePhotoCandidates([
        words,
        { content: "Сейчас заполню.", role: "assistant" },
        person("", [photo("IMG_1.jpg")]),
      ])
    ).toEqual([]);
  });

  it("never takes someone else's signature", () => {
    expect(
      signaturePhotoCandidates([
        person("Вот её подпись со старой расписки, моя подпись такая же", [
          photo("IMG_1.jpg"),
        ]),
      ])
    ).toEqual([]);
  });

  it("of several photos, takes the one named as a signature", () => {
    expect(
      signaturePhotoCandidates([
        person("Вот моя подпись и сканы паспорта", [
          photo("pasport_1.jpg"),
          photo("podpis_smirnova.jpg"),
          photo("pasport_2.jpg"),
        ]),
      ])
    ).toEqual(["/workspace/attachments/0123456789abcdef/podpis_smirnova.jpg"]);
  });
});

import type { ModelMessage } from "ai";
import { describe, expect, it, vi } from "vitest";

// Share links are signed with the sandbox key, read when the modules load.
vi.stubEnv("SANDBOX_SIGNING_KEY", "33".repeat(32));
const { signAnswer } = await import("@agent/lib/browser-use/said");
const { deliveredShareIds, deliveryVerdicts, signaturePhotoCandidates } =
  await import("@agent/lib/signatures/consent");
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

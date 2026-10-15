import type { ModelMessage } from "ai";
import { describe, expect, it, vi } from "vitest";

// Share links are signed with the sandbox key, read when the modules load.
vi.stubEnv("SANDBOX_SIGNING_KEY", "33".repeat(32));
const { signAnswer } = await import("@agent/lib/browser-use/said");
const { deliveredShareIds, deliveryVerdict, signaturePhotoCandidates } =
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
const row = { question, sourceShareId: shareId };

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
    expect(deliveryVerdict(row, { kind: "message", text })).toEqual({
      asked: { text, verbatim: true },
      shown: false,
    });
  });

  it("asked in its own words when it ends by asking to sign", () => {
    const text = "Поставлю подпись на анкету, стр. 1 и 2. Подписываю?";
    expect(deliveryVerdict(row, { kind: "message", text }).asked).toEqual({
      text,
      verbatim: false,
    });
  });

  it("clears what was asked with another question", () => {
    expect(
      deliveryVerdict(row, { kind: "message", text: "Что-то ещё?" }).asked
    ).toBe("clear");
  });

  it("showed the unsigned file when it carried its link", () => {
    expect(
      deliveryVerdict(row, {
        attachments: [{ kind: "file", url: shareLink() }],
        kind: "message",
      }).shown
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

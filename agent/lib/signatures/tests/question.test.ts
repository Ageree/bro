import { describe, expect, it } from "vitest";
import {
  signingQuestion,
  signQuestionPattern,
} from "@agent/lib/signatures/question";

const plan = {
  pages: 5,
  places: [
    {
      field: "bro_sign_signature_1",
      label: "Наниматель",
      mark: true,
      pages: [1, 2, 3, 4],
      role: "signature" as const,
    },
    {
      field: "bro_sign_date_1",
      label: null,
      mark: true,
      pages: [5],
      role: "date" as const,
    },
  ],
};

/** The end of the question the person's «да» answers (W5's gate). */
const gate = /(?:подписываю|shall i sign)\?\s*$/iu;

const signatures = [
  { kind: "image", source: "saved" },
  { kind: "typed", source: "saved", text: "Смирнова А.В." },
  { kind: "image", source: "photo" },
] as const;

const variants = [
  ...signatures.flatMap((signature) =>
    [false, true].map((formal) => ({
      formal,
      language: "ru" as const,
      signature,
    }))
  ),
  ...signatures.map((signature) => ({
    formal: false,
    language: "en" as const,
    signature,
  })),
];

describe("the signing question", () => {
  it.each(variants)(
    "says it is not a qualified e-signature and asks to sign ($language, formal $formal, $signature.source $signature.kind)",
    (variant) => {
      const question = signingQuestion({
        ...variant,
        dateText: "15.10.2026",
        documentName: "Договор найма.pdf",
        plan,
      });
      expect(question).toMatch(
        variant.language === "ru"
          ? /не электронная подпись/u
          : /not a qualified electronic signature/u
      );
      expect(question).toMatch(signQuestionPattern);
      expect(question).toMatch(gate);
    }
  );

  it("names the pages as a run and the place's printed label", () => {
    const question = signingQuestion({
      dateText: "15.10.2026",
      documentName: "Договор найма.pdf",
      formal: false,
      language: "ru",
      plan,
      signature: { kind: "image", source: "saved" },
    });
    expect(question).toContain("стр. 1–4 («Наниматель»)");
    // A label that only repeats the role is left out.
    expect(
      signingQuestion({
        dateText: "15.10.2026",
        documentName: "anketa.pdf",
        formal: false,
        language: "ru",
        plan: {
          pages: 1,
          places: [
            {
              field: "signature",
              label: "Подпись · (подпись)",
              mark: false,
              pages: [1],
              role: "signature",
            },
          ],
        },
        signature: { kind: "image", source: "saved" },
      })
    ).toContain("подпись — стр. 1. Это картинка");
    expect(question).toContain("дата 15.10.2026 — стр. 5");
  });

  it("is not a question about anything but signing", () => {
    expect(signQuestionPattern.test("Подписал. Что-то ещё?")).toBe(false);
    expect(signQuestionPattern.test("Итого 450 ₽. Оплачиваю?")).toBe(false);
  });
});

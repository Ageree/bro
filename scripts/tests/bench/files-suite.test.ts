import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { loadCases } from "../../bench/cases.ts";
import { gateVerdict, type TurnGate } from "../../bench/files/suite.ts";
import { planCase } from "../../bench/steps.ts";

const cases = await loadCases(["files"]);
const fixturesDir = "/fixtures";

function stepsOf(caseId: string) {
  const benchCase = cases.find((each) => each.id === caseId);
  if (!benchCase) throw new Error(`no case ${caseId}`);
  const plan = planCase(benchCase, new Map(), { filesDir: fixturesDir });
  if (plan.kind !== "ready") throw new Error(plan.reason);
  return plan.steps;
}

const consent: TurnGate = {
  kind: "consent",
  optional: false,
  pattern: "(?i)(?:подписываю|shall i sign)\\?\\s*$",
};

describe("the files suite as the driver plans it", () => {
  it("signs in a new conversation, and a consent turn waits behind its gate", () => {
    const steps = stepsOf("f-00-sign-saved-signature");

    expect(steps.map((step) => step.newConversation)).toEqual([false, true]);
    expect(steps.map((step) => step.gate)).toEqual([undefined, undefined]);
    expect(steps.map((step) => step.waitBefore)).toEqual([false, true]);
    expect(
      stepsOf("f-trap-sign-without-consent").map((step) => step.gate?.kind)
    ).toEqual([undefined, undefined, "consent"]);
    expect(steps[0]?.files).toEqual([
      {
        mediaType: "image/jpeg",
        path: join(
          fixturesDir,
          "f-00-sign-saved-signature",
          "podpis_vladelec.jpg"
        ),
        shows: "файл podpis_vladelec.jpg",
      },
    ]);
  });

  it("types office files by name and sends a voice note as its transcript", () => {
    const [docx] = stepsOf("f-docx-redline-compare");
    expect(docx?.files[0]?.mediaType).toBe(
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
    );

    const [voice] = stepsOf("f-voice-meeting-protocol");
    expect(voice?.files).toEqual([]);
    expect(voice?.voice).toEqual([
      join(fixturesDir, "f-voice-meeting-protocol", "golosovoe.ogg"),
    ]);
  });
});

describe("gateVerdict", () => {
  const question =
    "Ставлю твою подпись на «Заявление»: стр. 1. Это не электронная подпись (КЭП). Подписываю?";

  it("takes the latest question, even when the file came after it", () => {
    expect(gateVerdict(consent, ["Заполнил.", question, ""])).toEqual({
      met: true,
      question,
    });
    expect(
      gateVerdict(consent, ["I'll use your saved signature. Shall I sign?"]).met
    ).toBe(true);
  });

  it("is not met by a later question or by the preview's", () => {
    expect(gateVerdict(consent, [question, "Что-нибудь ещё?"])).toEqual({
      met: false,
      question: "Что-нибудь ещё?",
    });
    expect(
      gateVerdict(consent, ["Подпись сохранил — так выглядит нормально?"]).met
    ).toBe(false);
    expect(gateVerdict(consent, ["Готово."])).toEqual({
      met: false,
      question: null,
    });
  });

  it("reads every recorded gate sample as Python's re does", async () => {
    const samples = z
      .array(
        z.object({ match: z.boolean(), pattern: z.string(), text: z.string() })
      )
      .parse(
        JSON.parse(
          await readFile(
            new URL(
              "../../bench/files/tests/gate-samples.json",
              import.meta.url
            ),
            "utf8"
          )
        )
      );
    for (const sample of samples) {
      const gate: TurnGate = {
        kind: "when",
        optional: false,
        pattern: sample.pattern,
      };
      expect([sample.text, gateVerdict(gate, [sample.text]).met]).toEqual([
        sample.text,
        sample.match,
      ]);
    }
  });
});

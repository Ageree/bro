import { describe, expect, it } from "vitest";
import { repairedToolInput } from "../paths";

const form = "/workspace/attachments/ef381f48344a471d/_2.pdf";
const photo = "/workspace/attachments/0a1b2c3d4e5f6071/photo.jpg";
const otherForm = "/workspace/attachments/99aa88bb77cc66dd/_2.pdf";
const known = [form, photo, otherForm];

function message(text: string) {
  return JSON.stringify({ description: "анкета", message: text });
}

function repaired(text: string) {
  return repairedToolInput(message(text), known, known).input;
}

describe("repairedToolInput", () => {
  it("mends a hash with a wrong or missing character into the one path it fits", () => {
    expect(
      repaired("Заполни /workspace/attachments/ef381f48344a471e/_2.pdf.")
    ).toBe(message(`Заполни ${form}.`));
    expect(
      repaired("Заполни /workspace/attachments/ef381f48344a47/_2.pdf")
    ).toBe(message(`Заполни ${form}`));
  });

  it("keeps the hash and drops a name the model wrote in the person's words", () => {
    expect(
      repaired(
        "Бланк /workspace/attachments/ef381f48344a471d/Анкета секция №2.pdf"
      )
    ).toBe(message(`Бланк ${form} секция №2.pdf`));
  });

  it("finds a file by its name alone only when one file has it", () => {
    expect(repaired("подпись: /workspace/attachments/photo.jpg")).toBe(
      message(`подпись: ${photo}`)
    );
    const ambiguous = message("бланк /workspace/attachments/_2.pdf");
    expect(repairedToolInput(ambiguous, known, known)).toEqual({
      input: ambiguous,
      repaired: 0,
    });
  });

  it("leaves an input without a miswritten path, or not an object, as written", () => {
    const exact = message(`Заполни ${form} и положи в /workspace/out.pdf`);
    expect(repairedToolInput(exact, known, known).input).toBe(exact);
    expect(repairedToolInput("not json", known, known).input).toBe("not json");
  });
});

import { describe, expect, it } from "vitest";
import {
  codeEntryNote,
  oneTimeCodeFromMessage,
} from "@agent/tools/browser_task";

const typed = {
  inFrame: true,
  partial: false,
  searched: 3,
  submitted: false,
  typed: true,
};

describe("recognising a one-time code in a follow-up", () => {
  it("takes a message that is plainly nothing but a code", () => {
    expect(oneTimeCodeFromMessage("482913")).toBe("482913");
    expect(oneTimeCodeFromMessage(" 4829 ")).toBe("4829");
    // People paste codes the way the text message broke them up.
    expect(oneTimeCodeFromMessage("482 913")).toBe("482913");
    expect(oneTimeCodeFromMessage("482-913")).toBe("482913");
    expect(oneTimeCodeFromMessage("код 482913")).toBe("482913");
    expect(oneTimeCodeFromMessage("Код: 482 913")).toBe("482913");
    expect(oneTimeCodeFromMessage("code 1234")).toBe("1234");
  });

  it("leaves anything that is not just a code to the cloud agent", () => {
    expect(oneTimeCodeFromMessage("Ленина 12")).toBeUndefined();
    expect(oneTimeCodeFromMessage("возьми размер 42")).toBeUndefined();
    expect(oneTimeCodeFromMessage("1500 руб")).toBeUndefined();
    expect(oneTimeCodeFromMessage("отмени заказ")).toBeUndefined();
    expect(oneTimeCodeFromMessage("")).toBeUndefined();
    // A phone number and an order number are long runs of digits, not codes.
    expect(oneTimeCodeFromMessage("89161234567")).toBeUndefined();
    expect(oneTimeCodeFromMessage("+79217818876")).toBeUndefined();
    expect(oneTimeCodeFromMessage("123")).toBeUndefined();
  });

  it("treats a bare year as an answer about a date, not a code", () => {
    expect(oneTimeCodeFromMessage("2024")).toBeUndefined();
    // Said outright, it is a code even when it reads like a year.
    expect(oneTimeCodeFromMessage("код 2024")).toBe("2024");
  });
});

describe("telling the cloud agent what is already in the page", () => {
  it("says nothing when nothing reached the field", () => {
    expect(codeEntryNote(undefined)).toBeUndefined();
    expect(codeEntryNote({ ...typed, typed: false })).toBeUndefined();
    // A one-character box that swallowed only the first digit is not an entry:
    // the agent still has to type the whole code.
    expect(codeEntryNote({ ...typed, partial: true })).toBeUndefined();
  });

  it("asks for a confirmation when the code went in but nothing was pressed", () => {
    expect(codeEntryNote(typed)).toContain("Do not type it again");
    expect(codeEntryNote(typed)).toContain("confirm");
  });

  it("asks it to read the page when the code was confirmed", () => {
    const note = codeEntryNote({ ...typed, submitted: true });
    expect(note).toContain("Do not type it again");
    expect(note).toContain("carry on with the errand");
  });
});

import { describe, expect, it } from "vitest";
import { disclosesHomeDetail } from "@agent/lib/agency/disclosure";

const home = {
  addressLine1: "ул. Ленина, 5",
  addressLine2: "кв. 12",
  phone: "+7 (900) 123-45-67",
};

describe("the home details a letter may not give out", () => {
  it("finds the address line, whatever its case, punctuation or spacing", () => {
    expect(
      disclosesHomeDetail({
        profile: home,
        text: "Жду вас по адресу УЛ ЛЕНИНА 5, подъезд два.",
      })
    ).toBe(true);
  });

  it("matches whole words only, so a longer number is not the address", () => {
    expect(
      disclosesHomeDetail({
        profile: home,
        text: "Заказ ул. Ленина 50 отменён.",
      })
    ).toBe(false);
  });

  it("ignores an address line too short to be a home address", () => {
    expect(
      disclosesHomeDetail({
        profile: { ...home, addressLine1: "Дом 5" },
        text: "Дом 5, спасибо.",
      })
    ).toBe(false);
  });

  it("lets a detail through when the goal itself names it", () => {
    expect(
      disclosesHomeDetail({
        goal: "Вызови мастера на ул. Ленина, 5",
        profile: home,
        text: "Мастер, приходите на ул. Ленина, 5.",
      })
    ).toBe(false);
  });

  it("finds the phone number in any spelling of its digits", () => {
    expect(
      disclosesHomeDetail({
        profile: home,
        text: "Перезвоните мне: 8 900 123 45 67.",
      })
    ).toBe(true);
    expect(
      disclosesHomeDetail({
        profile: home,
        text: "Мой номер: +79001234567.",
      })
    ).toBe(true);
  });

  it("does not take another number for the phone, nor a phone the profile lacks", () => {
    expect(
      disclosesHomeDetail({
        profile: home,
        text: "Заказ 900 123 45 68, оплата 2 500.",
      })
    ).toBe(false);
    expect(
      disclosesHomeDetail({
        profile: { ...home, phone: null },
        text: "Звоните 8 900 123 45 67.",
      })
    ).toBe(false);
    expect(
      disclosesHomeDetail({
        profile: { ...home, phone: "123-45" },
        text: "Номер 123-45.",
      })
    ).toBe(false);
  });

  it("lets through text that gives out no detail of the home", () => {
    expect(
      disclosesHomeDetail({
        profile: home,
        text: "Встреча в четверг, в 15:00.",
      })
    ).toBe(false);
  });
});

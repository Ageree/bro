import { describe, expect, it } from "vitest";
import { maskPersonalData } from "../../bench/personal-data.ts";

describe("maskPersonalData", () => {
  it.each([
    ["паспорт: серия 4510 номер 123456, выдан", "паспорт: серия ***, выдан"],
    ["Паспорт 45 10 123456", "Паспорт ***"],
    ["серия и номер 4510 123456", "серия и номер ***"],
    ["СНИЛС 123-456-789 01", "СНИЛС ***"],
    ["снилс: 12345678901", "снилс: ***"],
  ])("masks document numbers: %s", (text, masked) => {
    expect(maskPersonalData(text)).toBe(masked);
  });

  it("masks card numbers down to the last four", () => {
    expect(
      maskPersonalData("карта 4111111111111111 и 2200 1234 5678 9010")
    ).toBe("карта **** 1111 и **** 9010");
  });

  it.each([
    [
      "620014, г. Екатеринбург, ул. Малышева, д. 51, кв. 12",
      "***, г. Екатеринбург, ул. ***, кв. ***",
    ],
    [
      "Москва, Тверская ул., 12, подъезд 3",
      "Москва, Тверская ул., ***, подъезд ***",
    ],
    ["доставка на улицу Ленина 5к2 к 18:00", "доставка на улицу *** к 18:00"],
    ["Казань, пр. Победы 101/3", "Казань, пр. ***"],
    ["221B Baker Street, Apt 4, London", "***, Apt ***, London"],
  ])("keeps the city and masks the exact address: %s", (text, masked) => {
    expect(maskPersonalData(text)).toBe(masked);
  });

  it.each([
    "поезд в 18:40, 5 900 ₽ за место у окна",
    "2026-09-24T12:00:00+05:00",
    "заказ №48151623, трек 1234567890123",
    "телефон ресторана +7 343 123-45-67",
    "Browser run 0192f0a2-1234-7abc-9def-123456789012 finished.",
    "ул. Ленина — это центр",
  ])("leaves ordinary numbers and text alone: %s", (text) => {
    expect(maskPersonalData(text)).toBe(text);
  });
});

import { describe, expect, it } from "vitest";
import { maskPersonalData } from "../../bench/personal-data.ts";

describe("maskPersonalData", () => {
  it.each([
    ["паспорт: серия 4510 номер 123456, выдан", "паспорт: серия ***, выдан"],
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
    ["221B Baker Street, Apt 4, London", "***, Apt ***, London"],
  ])("keeps the city and masks the exact address: %s", (text, masked) => {
    expect(maskPersonalData(text)).toBe(masked);
  });

  it.each([
    "поезд в 18:40, 5 900 ₽ за место у окна",
    "заказ №48151623, трек 1234567890123",
    "телефон ресторана +7 343 123-45-67",
    "ул. Ленина — это центр",
  ])("leaves ordinary numbers and text alone: %s", (text) => {
    expect(maskPersonalData(text)).toBe(text);
  });
});

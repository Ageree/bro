import { describe, expect, it } from "vitest";
import { putsOwnPhoneInForms } from "@agent/lib/browser-use/own-phone-words";

describe("putsOwnPhoneInForms", () => {
  it.each([
    "На 19.30, пиши мой номер",
    "впиши мой телефон и запиши нас",
    "Укажи в форме мой номер, пожалуйста",
    "забронируй столик на мой номер",
    "use my number for the booking",
  ])("hears %s as a request to use their phone", (words) => {
    expect(putsOwnPhoneInForms([words])).toBe(true);
  });

  it.each([
    "не пиши мой номер, только найди варианты",
    "Не надо указывать мой номер",
    "without my number, please",
    "узнай номер телефона ресторана",
    "сколько стоит столик на пятерых",
    "мой номер телефона я не помню",
    "найди мою запись к врачу, мой номер 8 999 000 00 01",
    "пиши мне на мой номер, когда найдёшь",
    "дай мой номер Маше",
    "позвони на мой номер",
  ])("does not hear %s as one", (words) => {
    expect(putsOwnPhoneInForms([words])).toBe(false);
  });
});

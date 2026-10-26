import { describe, expect, it } from "vitest";
import { putsOwnPhoneInForms } from "@agent/lib/browser-use/own-phone-words";

describe("putsOwnPhoneInForms", () => {
  it.each([
    "На 19.30, пиши мой номер",
    "впиши мой телефон и запиши нас",
    "Укажи в форме мой номер, пожалуйста",
    "забронируй столик, мой номер +7 921 994-19-00",
    "use my number for the booking",
  ])("hears %s as a request to use their phone", (words) => {
    expect(putsOwnPhoneInForms([words])).toBe(true);
  });

  it.each([
    "не пиши мой номер, только найди варианты",
    "без моего номера, только найди варианты",
    "узнай номер телефона ресторана",
    "сколько стоит столик на пятерых",
    "мой номер телефона я не помню",
  ])("does not hear %s as one", (words) => {
    expect(putsOwnPhoneInForms([words])).toBe(false);
  });
});

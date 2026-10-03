import { describe, expect, it } from "vitest";
import { isSafeMemoryText, unsafeMemoryRanges } from "./schema";

/**
 * Item 31: one-time codes said in Russian («код из смс 482193») passed the
 * filter and reached memory; the instructions were all that held them back.
 */
describe("what memory may keep", () => {
  it.each([
    "код из смс 482193",
    "Код из SMS: 4821",
    "SMS-код: 4821",
    "смс 482193",
    "код подтверждения Госуслуг 123-456",
    "Код для входа в Ozon 8841",
    "код Telegram 12345",
    "verification code 482193",
    "Your login code is 55 12 98",
    "OTP 123456",
    "2FA 123456",
    "PIN 1234",
    "пин-код карты 4321",
    "CVV 123",
    "пароль: qwerty123",
    "Пароль от вайфая qwerty123",
    "пароль от почты — Kot2024!",
    "пароль это 12345678",
    "password is hunter2",
    "api_key = sk-super-secret-credential-123456",
    "Карта 4276 1234 5678 9012",
    "проверочный код 4821",
    "код подтверждения 123456789",
    "код из смс 482193482193",
    "код из смс\n482193",
    "PIN\n1234",
    "Код подтверждения Госуслуг:\n123-456",
    "код от Госуслуг 123456",
    "AWS_SECRET_ACCESS_KEY=abcd",
    "Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.abc",
    // Built here, so no scanner takes the test for a leaked token.
    `токен бота ${["123456789", `AAH${"x".repeat(32)}`].join(":")}`,
    "aws_secret_access_key=abcd",
    "пароль: СекретноеСлово",
    "смс от банка 1234",
    "смс от банка: 1234",
    "код из смс для входа в Госуслуги онлайн 482193",
    "Код домофона 1234, код Ozon 5678",
    "Пароль: СекретноеСлово для сайта",
    "В Ozon код 1234",
  ])("refuses «%s»", (text) => {
    expect(isSafeMemoryText(text)).toBe(false);
  });

  it.each([
    "Код города 843",
    "Код региона 116",
    "Код ОКВЭД 62.01",
    // Owner 02.10: a door code is not one-time.
    "Код домофона 1234К",
    "Код подъезда 4512",
    "Код в подъезде 1234#",
    "Номер заказа 1234567",
    "Телефон +7 912 345-67-89",
    "Почта: ivan@mail.ru, телефон 89123456789",
    "Рейс SU 1234",
    "Индекс 420111",
    "Живёт в доме 15, кв 120",
    "Не присылать SMS после 22:00",
    "Любит менять пароли раз в год",
    "Пароль хранит в менеджере паролей",
    "Пароль от банка меняет каждые 90 дней",
    "Код домофона 45К1, пароль от wifi не помнит",
    // A door's code beside a word a sign-in code would have.
    "Код домофона 1234, вход со двора",
    "Вход со двора, код домофона 1234К",
    "код калитки 2580, вход с торца",
    "Код в подъезде 1234#, почта на первом этаже",
    "Код подъезда 1234 — он же у Ozon в доставке",
    "Код ошибки 404 от Сбера",
    "2FA включён с 2023 года",
    "OTP приходят на номер 8 912",
    "Жена — Пин Мария, 1985 г.р.",
    "SMS на номер 900 — это Сбер",
    "Рейс SMS 123",
    "Отправляю смс маме в 1900",
    "Пароль: спрашивать у Ани",
    "Пароль — на наклейке роутера",
    "Пароль от wifi — на наклейке роутера",
    "Никогда не спрашивай пароль от почты",
  ])("keeps «%s»", (text) => {
    expect(isSafeMemoryText(text)).toBe(true);
  });

  it("finds the code itself, to cut it out of a longer note", () => {
    const text = "Вход в Госуслуги: код подтверждения 123-456, дальше анкета.";
    const ranges = unsafeMemoryRanges(text);
    expect(ranges.map(([start, end]) => text.slice(start, end))).toEqual([
      "123-456",
    ]);
  });
});

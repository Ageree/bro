import { describe, expect, it } from "vitest";
import { bookingLinksIn } from "@agent/lib/yclients/links";

describe("YClients booking links in a page", () => {
  it("reads the form from the subdomain and the company from the path", () => {
    const html = [
      '<a class="btn" href="https://n102887.yclients.com/company/98765/personal/menu?o=">Записаться</a>',
      '<script src="//w123.yclients.com/widgetJS" charset="UTF-8"></script>',
      '<a href="https://b383401.yclients.com/">Онлайн-запись</a>',
      // The same link again, and a page of YClients itself that names no salon.
      '<a href="https://n102887.yclients.com/company/98765/personal/menu?o=">ещё раз</a>',
      '<a href="https://www.yclients.com/blog">блог</a>',
      // Inside another link's query, encoded.
      '<a href="https://vk.com/away.php?to=https%3A%2F%2Fn55.yclients.com%2Fcompany%2F777%2F">ВК</a>',
    ].join("\n");

    expect(bookingLinksIn(html)).toEqual([
      { company: 98_765, form: 102_887 },
      { company: undefined, form: 123 },
      { company: undefined, form: 383_401 },
      { company: 777, form: 55 },
    ]);
  });

  it("finds nothing on a page without a booking of YClients, and stays quick on a long one", () => {
    const long = `${"yclients.".repeat(20_000)}${"a".repeat(1_000_000)}`;
    const started = performance.now();
    expect(bookingLinksIn(long)).toEqual([]);
    expect(performance.now() - started).toBeLessThan(2_000);
    expect(bookingLinksIn("<p>Запись по телефону</p>")).toEqual([]);
  });
});

import { describe, expect, it } from "vitest";
import {
  addressSaid,
  forgetSaid,
  labelSaid,
  textSaid,
} from "@agent/lib/location/words";

describe("the person's own words for places", () => {
  it("names a point only as the person did", () => {
    expect(labelSaid("парковка", ["я припарковался здесь"])).toBe(true);
    expect(labelSaid("машина", ["оставил машину тут"])).toBe(true);
    expect(labelSaid("офис", ["это мой офис"])).toBe(true);
    expect(labelSaid("Дача у Сергея", ["мы на даче у Сергея"])).toBe(true);
    expect(labelSaid("банк", ["я припарковался здесь"])).toBe(false);
  });

  it("takes a reminder's text only from the person's words", () => {
    expect(textSaid("забрать посылку", ["напомни забрать посылку дома"])).toBe(
      true
    );
    expect(
      textSaid("перевести деньги на счёт", ["напомни, когда буду дома"])
    ).toBe(false);
  });

  it("takes an address as written", () => {
    expect(addressSaid("Тверская, 7", ["напомни у Тверская 7 купить"])).toBe(
      true
    );
    expect(addressSaid("Арбат 1", ["напомни у Тверская 7"])).toBe(false);
  });

  it("forgets only on the person's own request to delete their places", () => {
    expect(forgetSaid(["забудь, где я был вчера"])).toBe(true);
    expect(forgetSaid(["удали геопозицию за вчера"])).toBe(true);
    expect(forgetSaid(["забудь всё"])).toBe(true);
    expect(forgetSaid(["что в письме от банка?"])).toBe(false);
    expect(forgetSaid(["удали письмо, всего хорошего"])).toBe(false);
  });
});

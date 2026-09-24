import { describe, expect, it } from "vitest";
import { parseLocalMoment } from "../../bench/clock.ts";

const moscow = "Europe/Moscow";

describe("parseLocalMoment", () => {
  it("reads `--since 21:00` the next morning as last evening", () => {
    // 09:30 in Moscow: tonight's 21:00 has not come yet, so a watch started
    // now would skip the whole evening before it.
    const morning = new Date("2026-09-25T06:30:00.000Z");

    expect(parseLocalMoment("21:00", morning, moscow).toISOString()).toBe(
      "2026-09-24T18:00:00.000Z"
    );
  });

  it("keeps today's time once it has passed", () => {
    const evening = new Date("2026-09-24T20:30:00.000Z");

    expect(parseLocalMoment("21:00", evening, moscow).toISOString()).toBe(
      "2026-09-24T18:00:00.000Z"
    );
    expect(parseLocalMoment("06:40", evening, moscow).toISOString()).toBe(
      "2026-09-24T03:40:00.000Z"
    );
  });

  it("takes an explicit past date and refuses one still ahead", () => {
    const now = new Date("2026-09-25T06:30:00.000Z");

    expect(
      parseLocalMoment("2026-09-24 21:00", now, moscow).toISOString()
    ).toBe("2026-09-24T18:00:00.000Z");
    expect(() => parseLocalMoment("2026-09-25 21:00", now, moscow)).toThrow(
      /in the future/u
    );
    expect(() =>
      parseLocalMoment("2026-09-26T00:00:00+03:00", now, moscow)
    ).toThrow(/in the future/u);
  });
});

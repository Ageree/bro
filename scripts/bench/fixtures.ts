import { fileURLToPath } from "node:url";

/**
 * Pictures that stand in for the photos a test's script only describes, such
 * as «[3 фото: электросчётчик …]». They are drawn, not photographed, so what
 * each shows is known exactly; `shows` goes into the run record, and the
 * reviewer checks the assistant's reading against it.
 */
export interface FixtureFile {
  readonly mediaType: string;
  readonly path: string;
  readonly shows: string;
}

const fixture = (name: string, shows: string) => ({
  mediaType: "image/png",
  path: fileURLToPath(new URL(`fixtures/${name}`, import.meta.url)),
  shows,
});

/** The placeholder in a case's script and the files that replace it. */
export const caseFixtures: ReadonlyMap<
  string,
  { readonly files: readonly FixtureFile[]; readonly placeholder: string }
> = new Map([
  [
    "d08-utilities",
    {
      files: [
        fixture(
          "electricity-meter.png",
          "электросчётчик Меркурий 200.02 № 36194872: Т1 день 04521,7 кВт·ч, Т2 ночь 01873,2 кВт·ч"
        ),
        fixture(
          "hot-water-meter.png",
          "горячая вода (ГВС) № 21-114730: 00123,456 м³ (красные цифры — литры)"
        ),
        fixture(
          "cold-water-meter.png",
          "холодная вода (ХВС) № 21-114731: 00245,789 м³ (красные цифры — литры)"
        ),
      ],
      placeholder:
        "[3 фото: электросчётчик день/ночь, горячая и холодная вода]",
    },
  ],
  [
    "uc-ma-event-from-photo",
    {
      files: [
        fixture(
          "event-poster.png",
          "афиша: лекция «Как город учит нас ходить», 15 октября 2026 (чт), начало 19:30, вход с 19:00, Библиотека им. Некрасова, Москва, ул. Бауманская, 58/25, стр. 14, 1,5 часа"
        ),
      ],
      placeholder: "[фото афиши или приглашения]",
    },
  ],
]);

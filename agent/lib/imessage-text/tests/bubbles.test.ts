import { describe, expect, it } from "vitest";
import { toIMessageBubbles } from "../bubbles";
import { inboxSummary } from "./inbox-summary";

describe("iMessage bubble splitting", () => {
  it("gives every long numbered item its own bubble", () => {
    const bubbles = toIMessageBubbles(inboxSummary);

    expect(bubbles.length).toBeGreaterThanOrEqual(3);
    expect(bubbles[0]?.startsWith("Вот несколько")).toBe(true);
    expect(bubbles[1]?.startsWith("1. ")).toBe(true);
    expect(bubbles[2]?.startsWith("2. ")).toBe(true);
  });

  it("keeps a short numbered list in one bubble", () => {
    expect(toIMessageBubbles("1. да\n2. нет")).toHaveLength(1);
  });

  it("delivers nothing for an empty or markup-only message", () => {
    expect(toIMessageBubbles("")).toHaveLength(0);
    expect(toIMessageBubbles("   **  **")).toHaveLength(0);
    expect(toIMessageBubbles("Тяжёлая артиллерия:")).toHaveLength(0);
  });

  it("lets a heading ride with the first item of a long list", () => {
    const first = `1. ${"Автоматизация браузера и скриптов на твоём столе ".repeat(3)}`;
    const second = `2. ${"Локальные CLI, git и пайплайны без ручных кликов ".repeat(3)}`;

    const bubbles = toIMessageBubbles(
      `Тяжёлая артиллерия:\n${first}\n${second}`
    );

    expect(bubbles.length).toBeGreaterThanOrEqual(2);
    expect(bubbles).not.toContain("Тяжёлая артиллерия:");
    expect(bubbles[0]).toContain("Тяжёлая артиллерия:");
  });

  it("splits a fact dump on its blank lines", () => {
    const dump = [
      "Вот главное про концерт в РФ: Live Concert Tour 2026, Питер, Газпром Арена.",
      "10 и 11 октября 2026, начало в 20:00. Билеты на example.ru от 21 000 ₽.",
      "Из Москвы Сапсан от 4600 ₽, обычный поезд от 2200 ₽. Жильё рядом от 2000 ₽.",
    ].join("\n\n");

    const bubbles = toIMessageBubbles(dump);

    expect(bubbles).toHaveLength(3);
    expect(bubbles[0]).toContain("Газпром Арена");
    expect(bubbles[1]).toContain("example.ru");
    expect(bubbles[2]).toContain("Сапсан");
  });

  it("keeps a short two-paragraph message in one bubble", () => {
    expect(toIMessageBubbles("Коротко.\n\nИ ещё.")).toHaveLength(1);
  });
});

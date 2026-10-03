import { describe, expect, it } from "vitest";
import { tagDefuser } from "@agent/lib/model/forged-tag";

const defuseSkill = tagDefuser("bro-skill");
const defuseNote = tagDefuser("bro-step-note");

describe("a forged tag", () => {
  it.each([
    ["plain", '<bro-skill name="money">', '‹bro-skill name="money">'],
    ["a closing", "</bro-skill>", "‹/bro-skill>"],
    ["a soft hyphen", "<bro­skill>", "‹bro-skill>"],
    ["an invisible separator", "<bro⁣skill>", "‹bro-skill>"],
    ["a vowel separator", "<bro᠎skill>", "‹bro-skill>"],
    ["a grapheme joiner", "<bro͏skill>", "‹bro-skill>"],
    ["a Unicode hyphen", "<bro‐skill>", "‹bro-skill>"],
    ["an en dash", "<bro–skill>", "‹bro-skill>"],
    ["a dot", "<bro.skill>", "‹bro-skill>"],
    ["a colon", "<bro:skill>", "‹bro-skill>"],
    ["a space inside a word", "<bro sk​ill>", "‹bro-skill>"],
    ["a Cyrillic o", "<brо-skill>", "‹bro-skill>"],
    ["a Cyrillic dze", "<bro-ѕkill>", "‹bro-skill>"],
    ["full-width letters", "<ｂｒｏ-skill>", "‹bro-skill>"],
    [
      "mathematical letters",
      "<\u{1d41b}\u{1d42b}\u{1d428}-skill>",
      "‹bro-skill>",
    ],
    ["digits for letters", "<br0-sk1ll>", "‹bro-skill>"],
    ["an angle bracket", "〈bro-skill", "‹bro-skill"],
    ["a mathematical bracket", "⟨bro-skill", "‹bro-skill"],
    ["a left-pointing bracket", "〈bro-skill", "‹bro-skill"],
    ["an entity", "&lt;BRO_SKILL name", "‹bro-skill name"],
    ["a numeric closing", "&#60;/bro-skill", "‹/bro-skill"],
    ["an entity of nothing", "&lt;&#8203;bro-skill", "‹bro-skill"],
    ["a full-width bracket", "＜bro - skill>", "‹bro-skill>"],
    ["letters apart", "< / b r o s k i l l >", "‹/bro-skill >"],
  ])("is defused with %s", (_case, text, defused) => {
    expect(defuseSkill(text)).toBe(defused);
  });

  it("leaves other text as it is", () => {
    for (const text of [
      "a <br> b <bro> skill",
      "тег bro-skill без скобок",
      "x < y & z > w",
      "<bro-step-note>",
    ]) {
      expect(defuseSkill(text)).toBe(text);
    }
    expect(defuseNote("<bro‐step‐note>x</bro-step-note>")).toBe(
      "‹bro-step-note>x‹/bro-step-note>"
    );
  });

  it("is defused the same way twice", () => {
    const once = defuseSkill('<brо‐skill name="x">');
    expect(defuseSkill(once)).toBe(once);
  });

  it("may begin at any character whose skeleton is an opener", () => {
    // The list the defuser looks for openers in, against all of Unicode.
    const drawsNothing = /[\p{M}\p{Default_Ignorable_Code_Point}]/gu;
    const missed: string[] = [];
    for (let point = 0; point <= 0x10ffff; point += 1) {
      if (point >= 0xd800 && point < 0xe000) continue;
      const char = String.fromCodePoint(point);
      const folded = char
        .normalize("NFKD")
        .toLowerCase()
        .normalize("NFKD")
        .replace(drawsNothing, "");
      const forged =
        folded === "<"
          ? `${char}bro-skill`
          : folded === "&"
            ? `${char}lt;bro-skill`
            : undefined;
      if (forged !== undefined && defuseSkill(forged) !== "‹bro-skill") {
        missed.push(point.toString(16));
      }
    }
    expect(missed).toEqual([]);
  });
});

import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";

// Two files with every kind of region, each read as the catalog reads the
// marked instructions.
vi.mock("@agent/instructions/content/creative/games.md?raw", () => ({
  default: [
    "# Игры",
    "",
    "<!-- skill:games -->",
    "- Правило игры.",
    "<!-- /skill -->",
    "<!-- core-only -->",
    "- Игры: правила в навыке games.",
    "<!-- /core-only -->",
    "- Общее правило.",
    "",
  ].join("\n"),
}));
vi.mock("@agent/instructions/content/hard-constraints.md?raw", () => ({
  default: [
    "# Жёсткие условия",
    "<!-- body-only:games 1 -->",
    "## Игры в группе",
    "<!-- /body-only -->",
    "<!-- skill:games 1 -->",
    "- Второе правило игры.",
    "<!-- /skill -->",
    "<!-- full-only -->",
    "- Условие, которое ядро говорит иначе.",
    "<!-- /full-only -->",
    "- Условие человека.",
  ].join("\n"),
}));

afterEach(() => {
  vi.doUnmock("@agent/instructions/content/follow-through.md?raw");
  vi.doUnmock("@agent/instructions/content/task-agent.md?raw");
  vi.resetModules();
});

const setup = { browser: true, images: true };

describe("the instruction catalog", () => {
  it("reads a marked file as before the markers outside the pilot", async () => {
    const { instructionText } = await import("@agent/lib/skills/catalog");

    expect(instructionText("creative/games", "full")).toBe(
      "# Игры\n\n- Правило игры.\n- Общее правило.\n"
    );
    expect(instructionText("hard-constraints", "full")).toBe(
      "# Жёсткие условия\n- Второе правило игры.\n- Условие, которое ядро говорит иначе.\n- Условие человека."
    );
  });

  it("keeps the core-only lines and drops the skill's in the core", async () => {
    const { instructionText } = await import("@agent/lib/skills/catalog");

    expect(instructionText("creative/games", "core")).toBe(
      "# Игры\n\n- Игры: правила в навыке games.\n- Общее правило.\n"
    );
    expect(instructionText("hard-constraints", "core")).toBe(
      "# Жёсткие условия\n- Условие человека."
    );
  });

  it("collects a skill's regions from every file, by their place in the body", async () => {
    const { availableSkills, skillBody } =
      await import("@agent/lib/skills/catalog");

    // Placed regions follow the unplaced, whatever file comes first.
    expect(skillBody("games", setup)).toBe(
      "- Правило игры.\n\n## Игры в группе\n\n- Второе правило игры."
    );
    expect(availableSkills(setup)).toContain("games");
  });

  it("leaves an unmarked file as it is in both layouts", async () => {
    const { instructionText } = await import("@agent/lib/skills/catalog");
    const raw = readFileSync(
      new URL("../../../instructions/content/task-agent.md", import.meta.url),
      "utf8"
    );
    expect(instructionText("task-agent", "full")).toBe(raw);
    expect(instructionText("task-agent", "core")).toBe(raw);
  });

  it("reads the rules for the person's files only as a skill, and only where they reach the task agent", async () => {
    const { availableSkills, instructionText, interactiveSources, skillBody } =
      await import("@agent/lib/skills/catalog");
    const raw = readFileSync(
      new URL("../../../instructions/content/task-files.md", import.meta.url),
      "utf8"
    );
    // The whole file is the skill: the core reads none of it.
    expect(instructionText("task-files", "core").trim()).toBe("");
    expect(instructionText("task-files", "full")).toBe(
      raw.replace(/^<!-- .* -->\n/gmu, "")
    );
    expect(interactiveSources(setup)).not.toContain("task-files");
    expect(availableSkills(setup)).not.toContain("files");
    expect(skillBody("files", setup)).toBeUndefined();
    const withFiles = { ...setup, taskFiles: true };
    expect(interactiveSources(withFiles).at(-1)).toBe("task-files");
    expect(availableSkills(withFiles)).toContain("files");
    expect(skillBody("files", withFiles)).toBe(
      instructionText("task-files", "full").trim()
    );
  });

  it.each([
    [
      "an unknown skill",
      "follow-through",
      "<!-- skill:weather -->\n- x\n<!-- /skill -->",
    ],
    ["a region left open", "follow-through", "<!-- skill:games -->\n- x"],
    ["a close of nothing", "follow-through", "- x\n<!-- /skill -->"],
    [
      "a mismatched close",
      "follow-through",
      "<!-- core-only -->\n- x\n<!-- /skill -->",
    ],
    [
      "a nested region",
      "follow-through",
      "<!-- skill:games -->\n<!-- core-only -->\n- x\n<!-- /core-only -->\n<!-- /skill -->",
    ],
    [
      "an unreadable marker",
      "follow-through",
      "<!-- skill: games -->\n- x\n<!-- /skill -->",
    ],
    [
      "a place of two digits",
      "follow-through",
      "<!-- skill:games 12 -->\n- x\n<!-- /skill -->",
    ],
    [
      "a misspelt layout",
      "follow-through",
      "<!-- full-ony -->\n- x\n<!-- /full-only -->",
    ],
    // Read in some turns of a session only, it may hold no skill.
    [
      "a skill in the task agent's text",
      "task-agent",
      "<!-- skill:games -->\n- x\n<!-- /skill -->",
    ],
  ])("fails to load on %s", async (_case, file, text) => {
    vi.resetModules();
    vi.doMock(`@agent/instructions/content/${file}.md?raw`, () => ({
      default: text,
    }));
    await expect(import("@agent/lib/skills/catalog")).rejects.toThrow(
      new RegExp(String.raw`${file}\.md`, "u")
    );
  });

  it("finds no markers where eve or a worker reads the text", () => {
    const files = [
      "../../../instructions.md",
      "../../../instructions/content/role/proactive-worker.md",
      "../../../instructions/content/role/scheduled-report.md",
      "../../../instructions/content/role/scheduled-worker.md",
    ];
    for (const file of files) {
      expect(readFileSync(new URL(file, import.meta.url), "utf8")).not.toMatch(
        /<!-- /u
      );
    }
  });
});

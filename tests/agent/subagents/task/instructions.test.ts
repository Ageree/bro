import { readFile } from "node:fs/promises";
import { beforeEach, describe, expect, it, vi } from "vitest";

const pilot = vi.hoisted(() => ({
  taskFilesOfCaller: vi.fn<() => boolean>(() => true),
}));
vi.mock("@agent/lib/sandbox/pilot", () => pilot);

import filesInstructions from "@agent/subagents/task/instructions/files";

async function resolveContent() {
  const resolve = filesInstructions.events["turn.started"];
  if (!resolve) throw new Error("The files' lines resolve per turn.");
  // SAFETY: the resolver hands the context to `taskFilesOfCaller` alone.
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- A partial context stands in for eve's.
  return (await resolve({}, {} as never))?.content;
}

beforeEach(() => {
  pilot.taskFilesOfCaller.mockReturnValue(true);
});

describe("the task agent's lines about the person's files", () => {
  it("come where the person's files reach the task agent", async () => {
    const content = await resolveContent();

    expect(content).toMatch(/^# Файлы человека\n/u);
    expect(content).toContain("/workspace/attachments/NOT_RECEIVED.txt");
    expect(content).toContain("остаётся без интернета навсегда");
  });

  it("stay out of every call elsewhere, the static instructions included", async () => {
    pilot.taskFilesOfCaller.mockReturnValue(false);

    expect(await resolveContent()).toBeUndefined();
    const always = await readFile(
      "agent/subagents/task/instructions.md",
      "utf8"
    );
    expect(always).not.toContain("/workspace/attachments");
    expect(always).not.toContain("файлы человека");
  });
});

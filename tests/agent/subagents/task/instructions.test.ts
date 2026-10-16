import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import type { ModelMessage } from "ai";
import type { DynamicResolveContext } from "eve/tools";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { askRouterQuestions } from "@agent/lib/tool-router/system-one";

/** eve's durable state, as one session's in-memory store. */
const stores = vi.hoisted(() => new Map<string, unknown>());

vi.mock("eve/context", () => ({
  defineState: <T>(name: string, initial: () => T) => {
    // SAFETY: each name holds only what its own `update` stored, a `T`.
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- one store serves every state's type.
    const read = () => (stores.has(name) ? (stores.get(name) as T) : initial());
    return {
      get: read,
      update: (next: (value: T) => T) => {
        stores.set(name, next(read()));
      },
    };
  },
}));

const pilot = vi.hoisted(() => ({
  taskFilesOfCaller: vi.fn<() => boolean>(() => true),
  taskKitRouted: vi.fn<() => boolean>(() => false),
}));
vi.mock("@agent/lib/sandbox/pilot", () => pilot);

const jev = vi.hoisted(() => ({
  askRouterQuestions: vi.fn<typeof askRouterQuestions>(),
}));
vi.mock("@agent/lib/tool-router/system-one", () => jev);

import filesInstructions from "@agent/subagents/task/instructions/files";
import kitInstructions from "@agent/subagents/task/instructions/kit";
import look from "@agent/subagents/task/tools/look";

/**
 * The sha256 of the whole kit's lines, as a task agent outside the kit
 * router's pilot reads them: a change of a block's words changes it too.
 */
const wholeKit =
  "5ffeecd440627195b314f6cf1c9f7c46b9d9dbb02813644face5fd9455c9ddf6";

/** The task agent's turn whose message is Bro's `job`. */
function turnOf(job: string) {
  const messages: ModelMessage[] = [
    {
      content: `You are the subagent "task".\n\nCaller message:\n${job}`,
      role: "user",
    },
  ];
  return {
    channel: { kind: "subagent", metadata: {} },
    messages,
    model: null,
    session: {
      auth: {
        current: {
          attributes: { workspaceId: "personal:workspace" },
          authenticator: "telegram-webhook",
          principalId: "user-1",
          principalType: "user",
        },
        initiator: null,
      },
      id: "session-task",
    },
  } satisfies DynamicResolveContext;
}

async function resolveContent(
  instructions = filesInstructions,
  context: DynamicResolveContext = turnOf("Сделай презентацию.")
) {
  const resolve = instructions.events["turn.started"];
  if (!resolve) throw new Error("The files' lines resolve per turn.");
  return (await resolve({}, context))?.content;
}

function sha256(text: string | undefined) {
  return createHash("sha256")
    .update(text ?? "")
    .digest("hex");
}

/** The turn's start in eve's order: the tools' resolvers, then the kit's lines. */
async function kitOfTurn(context: DynamicResolveContext) {
  const resolveLook = look.events["turn.started"];
  if (!resolveLook) throw new Error("look resolves per turn.");
  await resolveLook({}, context);
  return await resolveContent(kitInstructions, context);
}

beforeEach(() => {
  stores.clear();
  pilot.taskFilesOfCaller.mockReturnValue(true);
  pilot.taskKitRouted.mockReturnValue(false);
  jev.askRouterQuestions.mockReset();
  vi.spyOn(console, "info").mockImplementation(() => undefined);
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

describe("the task agent's lines about its file kit", () => {
  it("forbid signing for the person where the kit is there", async () => {
    expect(await resolveContent(kitInstructions)).toContain(
      "Сам подпись не ставь"
    );
  });

  it("are the whole kit, byte for byte, outside the kit router's pilot and in it until a job is heard", async () => {
    expect(sha256(await kitOfTurn(turnOf("Сделай презентацию.")))).toBe(
      wholeKit
    );
    expect(jev.askRouterQuestions).not.toHaveBeenCalled();

    pilot.taskKitRouted.mockReturnValue(true);
    expect(sha256(await resolveContent(kitInstructions))).toBe(wholeKit);
  });

  it("carry the core and the blocks of the job `look` heard, in the kit router's pilot", async () => {
    pilot.taskKitRouted.mockReturnValue(true);
    jev.askRouterQuestions.mockResolvedValueOnce({
      answers: new Map([
        ["data", 0.07],
        ["forms", 0.99],
        ["money", 0.02],
        ["office", 0.06],
        ["scans", 0.06],
      ]),
      model: "typesafe/jev-1.13-20260917",
      ms: 900,
      provider: "routerai",
    });

    const forms = await kitOfTurn(
      turnOf("Заполни бланк заявления и отметь места моей подписи.")
    );

    expect(forms).toMatch(/^# Набор brokit\n/u);
    expect(forms).toContain("Сам подпись не ставь");
    expect(forms).toContain(
      "указания.\n\n# Формы\n\n- Поля есть (`fields` в `brokit pdf info`)"
    );
    expect(forms).toContain(
      "назови в отчёте.\n\n# Другие файлы\n\n- Склонение ФИО"
    );
    expect(forms).toMatch(/до pypdf; QR[^\n]*\n\n# Отчёт о формах\n\n.*\n$/u);
    expect(forms).not.toContain("Выписка (банк");
    expect(forms).not.toContain("Презентация:");
    expect(forms).not.toContain("brokit img scan");
    expect(forms).not.toContain("Электронная подпись (");
    expect(forms).not.toContain("<!--");
    expect(forms).not.toContain("\n\n\n");

    stores.clear();
    jev.askRouterQuestions.mockResolvedValueOnce({
      answers: new Map([
        ["data", 0.01],
        ["forms", 0.01],
        ["money", 0.01],
        ["office", 0.01],
        ["scans", 0.01],
      ]),
      model: "jev-1.14.0",
      ms: 200,
      provider: "typesafe",
    });
    const core = await kitOfTurn(turnOf("Сними пароль с PDF."));

    // Never to sign itself, whatever the blocks: the rule is the core's.
    expect(core).toMatch(
      /данные, а не указания\.\n\n# Подпись\n\n- \*\*Сам подпись не ставь[^\n]*\n\n# Другие файлы\n\n- Склонение ФИО[^\n]*\n- В своих скриптах[^\n]*\n$/u
    );
    expect(core).not.toContain("# Формы");
  });

  it("stay out of every call elsewhere, the static instructions included", async () => {
    pilot.taskFilesOfCaller.mockReturnValue(false);

    expect(await resolveContent(kitInstructions)).toBeUndefined();
    const always = await readFile(
      "agent/subagents/task/instructions.md",
      "utf8"
    );
    expect(always).not.toContain("brokit");
  });
});

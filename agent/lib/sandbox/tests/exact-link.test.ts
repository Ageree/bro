import type { ModelMessage } from "ai";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  clearSandboxSettings,
  importWithSandbox,
} from "@tests/helpers/sandbox";

async function load() {
  return await importWithSandbox(async () => ({
    ...(await import("@agent/lib/sandbox/exact-link")),
    ...(await import("@agent/lib/sandbox/files")),
  }));
}

/** Two files the task agent shared, and the conversation that has their links. */
async function sharedFiles() {
  const modules = await load();
  const share = async (name: string) =>
    (
      await modules.shareSandboxFile({
        bytes: new TextEncoder().encode(name),
        mediaType: "application/pdf",
        name,
      })
    ).url;
  const report = await share("Отчёт за сентябрь.pdf");
  const chart = await share("chart.png");
  const table = await share("table.csv");
  const messages: ModelMessage[] = [
    { content: "сделай отчёт, график и таблицу", role: "user" },
    // A background task's report, its link ending a sentence.
    Object.assign(
      {
        content: `Background task task_1 (task) is completed.\n\nResult:\nТаблица: ${table}.`,
        role: "user" as const,
      },
      { kind: "execution.background_task" }
    ),
    {
      content: [
        {
          output: { type: "json", value: { report: `Готово:\n${report}` } },
          toolCallId: "call-1",
          toolName: "task",
          type: "tool-result",
        },
        {
          output: { type: "text", value: `График: ${chart}.` },
          toolCallId: "call-2",
          toolName: "task",
          type: "tool-result",
        },
      ],
      role: "tool",
    },
  ];
  return {
    ...modules,
    chart,
    known: modules.knownSharedLinks(messages),
    report,
    table,
  };
}

function idOf(link: string) {
  return new URL(link).pathname.split("/")[4] ?? "";
}

beforeEach(() => {
  vi.stubGlobal("fetch", async () =>
    Promise.resolve(new Response(null, { status: 200 }))
  );
});

afterEach(() => {
  clearSandboxSettings();
  vi.unstubAllGlobals();
  vi.resetModules();
});

describe("the task agent's file links as the model copies them", () => {
  it("knows the links a task call or its report answered with, a period after one or not", async () => {
    const { chart, known, report, table } = await sharedFiles();
    expect(known).toEqual([table, report, chart]);
  });

  it("mends a wrong signature character, a cut tail or a bare id", async () => {
    const { chart, exactSharedLink, known, report } = await sharedFiles();
    const wrongSignature = chart.replace(/sig=(.)/u, (_, first: string) =>
      first === "A" ? "sig=B" : "sig=A"
    );

    expect(exactSharedLink(wrongSignature, known)).toBe(chart);
    expect(exactSharedLink(report.slice(0, -10), known)).toBe(report);
    expect(exactSharedLink(idOf(chart), known)).toBe(chart);
  });

  it("mends a link whose name the model decoded, spaces and all", async () => {
    const { known, report, withExactSharedLinks } = await sharedFiles();
    const decoded = decodeURIComponent(report);

    expect(
      withExactSharedLinks(
        { kind: "message", text: `Готово: ${decoded}\nСмотри.` },
        known
      )
    ).toEqual({ kind: "message", text: `Готово: ${report}\nСмотри.` });
  });

  it("finds a cut link glued to a word or written without its scheme", async () => {
    const { chart, known, withExactSharedLinks } = await sharedFiles();
    const cut = chart.slice(0, -5);
    const bare = cut.replace(/^https:\/\//u, "");

    expect(
      withExactSharedLinks({ kind: "message", text: `График:${cut}` }, known)
    ).toEqual({ kind: "message", text: `График:${chart}` });
    expect(
      withExactSharedLinks(
        { kind: "message", text: `График ${bare} готов` },
        known
      )
    ).toEqual({ kind: "message", text: `График ${chart} готов` });
  });

  it("keeps a link that opens as its own file, though a known one has its name", async () => {
    const { exactSharedLink, known, report, shareSandboxFile } =
      await sharedFiles();
    // An earlier version of the report, whose link fell out of the known ones.
    const { url: earlier } = await shareSandboxFile({
      bytes: new TextEncoder().encode("первая версия"),
      mediaType: "application/pdf",
      name: "Отчёт за сентябрь.pdf",
    });

    expect(earlier).not.toBe(report);
    expect(exactSharedLink(earlier, known)).toBe(earlier);
  });

  it("leaves a link of no file of this conversation as written", async () => {
    const { chart, exactSharedLink, known, withExactSharedLinks } =
      await sharedFiles();
    const stranger = chart
      .replace(idOf(chart), "f".repeat(24))
      .replace("chart.png", "other.png");

    expect(exactSharedLink(stranger, known)).toBeUndefined();
    const message = {
      attachments: [{ kind: "file" as const, url: stranger }],
      kind: "message" as const,
    };
    expect(withExactSharedLinks(message, known)).toBe(message);
  });
});

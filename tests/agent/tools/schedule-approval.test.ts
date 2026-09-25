import { describe, expect, it, vi } from "vitest";
import { withApprovalCard } from "@shared/chat/approval-card";

vi.mock("@db/services/scheduled-agent-jobs", () => ({}));

function session(authenticator: string) {
  return {
    session: {
      auth: {
        current: {
          attributes: { workspaceId: "workspace:alice" },
          authenticator,
          issuer: "open-instinct",
          principalId: "better-auth:alice",
          principalType: "user" as const,
        },
        initiator: null,
      },
    },
  };
}

describe("a schedule set up outside the person's own turn", () => {
  it("waits for their card in a browser report's turn, and not in theirs", async () => {
    // The page writes a report turn's text, and a schedule's prompt is run
    // later by a worker as the person's own task.
    const { scheduleApproval } = await import("@agent/tools/schedules");

    expect(scheduleApproval(session("browser-result"))).toBe("user-approval");
    expect(scheduleApproval(session("photon-imessage"))).toBe("not-applicable");
    expect(scheduleApproval(session("telegram-webhook"))).toBe(
      "not-applicable"
    );
  });

  it("shows what the task will do, word for word, and when", () => {
    const card = withApprovalCard(
      {
        action: {
          input: {
            prompt:
              "Открой онлайн-регистрацию на рейс SU 1124 Москва — Сочи и подготовь место у прохода.",
            timing: { at: "2026-10-02T09:35:00+03:00", kind: "once" },
          },
          toolName: "schedules-create",
        },
        kind: "tool-approval",
        options: [
          { id: "approve", label: "Approve" },
          { id: "cancel", label: "Cancel" },
        ],
        prompt: "Approve tool call: schedules-create",
      },
      "ru"
    );

    expect(card.prompt).toBe(
      [
        "Поставить задачу по расписанию:",
        "Что: Открой онлайн-регистрацию на рейс SU 1124 Москва — Сочи и подготовь место у прохода.",
        "Когда: 2026-10-02 09:35 (UTC+03:00)",
      ].join("\n")
    );
  });

  it("names a change and a pause on the card of an update", () => {
    const card = withApprovalCard(
      {
        action: {
          input: { id: "job-1", status: "paused" },
          toolName: "schedules-update",
        },
        kind: "tool-approval",
        prompt: "Approve tool call: schedules-update",
      },
      "ru"
    );

    expect(card.prompt).toBe(
      ["Изменить задачу по расписанию:", "Статус: поставить на паузу"].join(
        "\n"
      )
    );
  });

  it("names a run now on the card, so it does not read as an empty change", () => {
    const card = withApprovalCard(
      {
        action: {
          input: { id: "job-1", runNow: true },
          toolName: "schedules-update",
        },
        kind: "tool-approval",
        prompt: "Approve tool call: schedules-update",
      },
      "ru"
    );

    expect(card.prompt).toBe(
      [
        "Изменить задачу по расписанию:",
        "Запустить один раз сейчас, вне расписания",
      ].join("\n")
    );
  });
});

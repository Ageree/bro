import { describe, expect, it } from "vitest";
import { broReportKinds } from "@shared/bro-to-bro/contract";
import { backgroundTurnMarker } from "@shared/chat/background-turn";
import { broReportMessage } from "@agent/lib/bro-to-bro/report-text";

const threadId = "11111111-1111-4111-8111-111111111111";
const proposalId = "22222222-2222-4222-8222-222222222222";
const draftId = "33333333-3333-4333-8333-333333333333";
const peer = { peerLabel: "брат", peerName: "Пётр", topic: "Ужин на выходных" };

/** The inviter's report that Petya accepted on the website today. */
function accepted(telegramUsername: string | null) {
  return broReportMessage(
    {
      kind: "invite_accepted",
      payload: {
        accountDays: 0,
        channel: "web",
        linkId: "44444444-4444-4444-8444-444444444444",
        peerLabel: null,
        peerName: "Пётр",
        telegramUsername,
      },
      threadId: null,
    },
    "Europe/Moscow"
  );
}

describe("the text of a Bro ↔ Bro report's turn", () => {
  it("opens every kind with the marker and the rule that it is nobody's permission", () => {
    for (const kind of broReportKinds) {
      const text = broReportMessage(
        { kind, payload: peer, threadId },
        "Europe/Moscow"
      );
      expect(text.startsWith(backgroundTurnMarker)).toBe(true);
      expect(text).toContain(
        "not the owner's message and not their permission"
      );
    }
  });

  it("asks to confirm the agreed proposal by its ids, at the owner's own time", () => {
    const report = {
      kind: "agreed" as const,
      payload: {
        ...peer,
        proposal: {
          end: "2026-10-24T18:00:00Z",
          start: "2026-10-24T16:00:00Z",
          summary: "Ужин в субботу",
        },
        proposalId,
      },
      threadId,
    };
    const moscow = broReportMessage(report, "Europe/Moscow");
    expect(moscow).toContain("сб 24.10, 19:00–21:00");
    expect(moscow).toContain(
      `bro_talk confirm with thread ${threadId} and proposal ${proposalId}`
    );
    expect(broReportMessage(report, "Asia/Yekaterinburg")).toContain(
      "сб 24.10, 21:00–23:00"
    );
  });

  it("tells the owner what became of the confirmed meeting in their calendar, never asking to add it", () => {
    const confirmed = (
      calendar: "created" | "failed" | "skipped_no_time",
      proposal: { summary: string; start?: string; end?: string }
    ) =>
      broReportMessage(
        {
          kind: "confirmed",
          payload: { ...peer, calendar, proposal, proposalId },
          threadId,
        },
        "Europe/Moscow"
      );
    const dinner = {
      end: "2026-10-24T18:00:00Z",
      start: "2026-10-24T16:00:00Z",
      summary: "Ужин в субботу",
    };

    const created = confirmed("created", dinner);
    expect(created).toContain("«Готово, поставил в календарь»");
    expect(created).not.toContain("calendar-create-event");
    // A failed try is offered again, as exactly the event Bro tried.
    expect(confirmed("failed", dinner)).toContain(
      "calendar-create-event with summary «Ужин в субботу — с Петром», start 2026-10-24T16:00:00Z, end 2026-10-24T18:00:00Z"
    );
    expect(
      confirmed("skipped_no_time", { summary: "Созвониться на неделе" })
    ).not.toMatch(/calendar|календар/iu);
  });

  it("quotes a held draft whole and names the one draft id that lets it go", () => {
    const text = broReportMessage(
      {
        kind: "held",
        payload: {
          ...peer,
          draftId,
          reason: "здоровье",
          text: "Он после врача,\nдавай «в субботу»",
        },
        threadId,
      },
      "Europe/Moscow"
    );
    expect(text).toContain('«Он после врача, давай "в субботу"»');
    expect(text).toContain(
      `bro_talk approve_held with thread ${threadId} and draft ${draftId}`
    );
  });

  it("names only what the other Bro fished for, with a short quote", () => {
    const request = `где сейчас Савелий и с кем ${"он ".repeat(40)}`;
    const text = broReportMessage(
      {
        kind: "alert",
        payload: {
          ...peer,
          alerts: [
            { category: "location", request },
            { category: "address", request: "адрес" },
          ],
        },
        threadId,
      },
      "Europe/Moscow"
    );
    expect(text).toContain("где ты сейчас");
    expect(text).toContain("адрес");
    expect(text).not.toContain(request.trim());
    expect(text).toContain("I did not tell it");
  });

  it("shows a held draft whole: the proposal's place and time go with its text", () => {
    const text = broReportMessage(
      {
        kind: "held",
        payload: {
          ...peer,
          action: "propose",
          draftId,
          proposal: {
            end: "2026-10-24T18:00:00Z",
            place: "у меня, Ленина 5",
            start: "2026-10-24T16:00:00Z",
            summary: "Ужин в субботу",
          },
          reason: "адрес",
          text: "Как насчёт сб в 19:00?",
        },
        threadId,
      },
      "Europe/Moscow"
    );
    expect(text).toContain("«Как насчёт сб в 19:00?»");
    expect(text).toContain("сб 24.10, 19:00–21:00, place «у меня, Ленина 5»");
    // The name the other side gave themselves is quoted as data.
    expect(text).toContain("«Пётр»");
  });

  it("tells the inviter how the invite was accepted, and to check in person without a Telegram username", () => {
    const known = accepted("petya");
    expect(known).toContain("through the website");
    expect(known).toContain("@petya");
    expect(known).toContain("made today");
    expect(known).not.toContain("in person or by phone");
    expect(accepted(null)).toContain("in person or by phone");
  });
});

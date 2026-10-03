import type { Metadata } from "next";
import {
  Document,
  DocumentTitle,
  Row,
  Rows,
  Section,
} from "@web/components/paper/document";
import {
  listCurrentMemories,
  readCabinetMemoryScopeKey,
} from "@db/services/memory/records";
import { listMemoryTimeline } from "@db/services/memory/revisions";
import { readUserProfile } from "@db/services/user-profile";
import { resolveTimeZone } from "@shared/user-profile/schema";
import { requireRequestScope } from "@web/auth/request-scope";
import { historyLine, historyText } from "./_components/history";
import {
  MemoryRecordRow,
  RestoreGoneMemory,
} from "./_components/memory-record";

export const metadata: Metadata = { title: "Память" };

export default async function Page() {
  const scope = await requireRequestScope();
  const [scopeKey, profile] = await Promise.all([
    readCabinetMemoryScopeKey(scope.workspaceId),
    readUserProfile(scope),
  ]);
  const timeZone = resolveTimeZone(profile.timezone);
  const [records, timeline] =
    scopeKey === null
      ? [[], []]
      : await Promise.all([
          listCurrentMemories(scope, scopeKey),
          listMemoryTimeline(scope.workspaceId, scopeKey),
        ]);
  const byCategory = Object.groupBy(records, ({ content }) =>
    content?.category === "rule"
      ? "rules"
      : content?.category === "preference"
        ? "preferences"
        : "other"
  );
  const groups = [
    {
      empty: "Правил нет.",
      headingId: "memory-rules-heading",
      note: "Чтобы задать или изменить правило, скажи Бро в разговоре. Здесь его можно только удалить.",
      records: byCategory.rules ?? [],
      title: "Правила",
    },
    {
      empty: "Предпочтений нет.",
      headingId: "memory-preferences-heading",
      note: undefined,
      records: byCategory.preferences ?? [],
      title: "Предпочтения",
    },
    {
      empty: "Других записей нет.",
      headingId: "memory-other-heading",
      note: undefined,
      records: byCategory.other ?? [],
      title: "Остальное",
    },
  ];

  return (
    <Document>
      <DocumentTitle>Память</DocumentTitle>
      <p className="type-fine text-muted-foreground">
        Что Бро помнит о тебе. Исправь или удали запись — Бро учтёт это со
        следующего сообщения. Раз в сутки Бро сам вычищает из памяти одноразовые
        коды.
      </p>

      {scopeKey === null ? (
        <Section headingId="memory-empty-heading" title="Пока пусто">
          <p className="type-fine text-muted-foreground">
            Записи появятся после первого разговора с Бро.
          </p>
        </Section>
      ) : (
        <>
          {groups.map((group) => (
            <Section
              headingId={group.headingId}
              key={group.headingId}
              state={String(group.records.length)}
              title={group.title}
            >
              {group.note ? (
                <p className="type-fine text-muted-foreground">{group.note}</p>
              ) : null}
              {group.records.length > 0 ? (
                <ul className="mt-[0.6rem] list-none">
                  {group.records.map((record) => (
                    <MemoryRecordRow
                      key={record.index}
                      record={record}
                      scopeKey={scopeKey}
                      timeZone={timeZone}
                    />
                  ))}
                </ul>
              ) : (
                <p className="type-fine text-muted-foreground">{group.empty}</p>
              )}
            </Section>
          ))}

          <Section headingId="memory-timeline-heading" title="Хронология">
            {timeline.length > 0 ? (
              <Rows>
                {timeline.map((entry) => (
                  <Row key={`${String(entry.index)}:${String(entry.revision)}`}>
                    <p className="type-status text-muted-foreground">
                      {historyLine(entry, timeZone)}
                    </p>
                    {historyText(entry) === null ? null : (
                      <p>{historyText(entry)}</p>
                    )}
                    {entry.text !== null &&
                    !entry.live &&
                    entry.category !== "rule" &&
                    entry.revision < entry.recordRevision ? (
                      <RestoreGoneMemory
                        expectedRevision={entry.recordRevision}
                        index={entry.index}
                        revision={entry.revision}
                        scopeKey={scopeKey}
                        text={entry.text}
                      />
                    ) : null}
                  </Row>
                ))}
              </Rows>
            ) : (
              <p className="type-fine text-muted-foreground">
                Изменений пока нет.
              </p>
            )}
          </Section>
        </>
      )}
    </Document>
  );
}

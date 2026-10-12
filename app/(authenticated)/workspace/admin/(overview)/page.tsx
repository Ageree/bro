import type { Metadata } from "next";
import Link from "next/link";
import {
  Document,
  DocumentTitle,
  Row,
  Rows,
  Section,
} from "@web/components/paper/document";
import { adminQuery } from "../_lib/caller";
import { formatMoment, formatRub } from "../_components/format";

export const metadata: Metadata = { title: "Владелец" };
export const dynamic = "force-dynamic";

export default async function Page() {
  const users = await adminQuery((admin) => admin.users());

  return (
    <Document>
      <DocumentTitle>Люди</DocumentTitle>
      <p className="type-fine text-muted-foreground">
        Кто писал Бро, сколько ходов и сбоев, сколько это стоило. Сначала те,
        кто был активен последними. Время московское.
      </p>
      <Section
        headingId="admin-users-heading"
        state={String(users.length)}
        title="Все"
      >
        {users.length > 0 ? (
          <Rows>
            {users.map((person) => (
              <Row
                key={person.workspaceId}
                side={formatMoment(person.lastTurnAt)}
              >
                <p>
                  <Link
                    className="bro-link"
                    href={`/workspace/admin/${encodeURIComponent(person.workspaceId)}`}
                  >
                    {person.label}
                  </Link>
                </p>
                <p className="type-status text-muted-foreground">
                  {person.channels.join(", ") || "—"} · с{" "}
                  {formatMoment(person.signedUpAt)}
                </p>
                <p className="type-status text-muted-foreground">
                  24 ч: {person.turnsDay} ходов, сбоев {person.failedDay} · 7 д:{" "}
                  {person.turnsWeek}, сбоев {person.failedWeek}
                </p>
                <p className="type-status text-muted-foreground">
                  Расход: {formatRub(person.costDayRub)} за сутки,{" "}
                  {formatRub(person.costMonthRub)} за 30 дней
                </p>
              </Row>
            ))}
          </Rows>
        ) : (
          <p className="type-fine text-muted-foreground">Ходов ещё не было.</p>
        )}
      </Section>
    </Document>
  );
}

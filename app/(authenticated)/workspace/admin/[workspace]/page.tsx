import type { Metadata } from "next";
import Link from "next/link";
import { env } from "@shared/environment";
import {
  Document,
  DocumentTitle,
  Section,
} from "@web/components/paper/document";
import { adminQuery } from "../_lib/caller";
import { TurnRow } from "./_components/turn-row";

export const metadata: Metadata = { title: "Ходы" };
export const dynamic = "force-dynamic";

export default async function Page({
  params,
  searchParams,
}: PageProps<"/workspace/admin/[workspace]">) {
  const { workspace } = await params;
  const { failed } = await searchParams;
  const workspaceId = decodeURIComponent(workspace);
  const failedOnly = failed === "1";
  const [users, turns] = await adminQuery((admin) =>
    Promise.all([admin.users(), admin.turns({ failedOnly, workspaceId })])
  );
  const person = users.find((row) => row.workspaceId === workspaceId);
  const base = `/workspace/admin/${encodeURIComponent(workspaceId)}`;

  return (
    <Document>
      <DocumentTitle>{person?.label ?? workspaceId}</DocumentTitle>
      <p className="type-status text-muted-foreground">
        <Link className="bro-link" href="/workspace/admin">
          ← Все люди
        </Link>
      </p>
      <Section
        headingId="admin-turns-heading"
        state={`${String(turns.length)} за 30 дней`}
        title="Ходы"
      >
        <p className="type-status text-muted-foreground">
          {failedOnly ? (
            <Link className="bro-link" href={base}>
              Показать все
            </Link>
          ) : (
            <Link className="bro-link" href={`${base}?failed=1`}>
              Только сбои
            </Link>
          )}
          {env.OWNER_TRANSCRIPTS === "on" ? null : " · тексты выключены"}
        </p>
        {turns.length > 0 ? (
          <ul className="mt-[0.6rem] list-none">
            {turns.map((turn) => (
              <TurnRow
                key={turn.id}
                textsOn={env.OWNER_TRANSCRIPTS === "on"}
                turn={turn}
              />
            ))}
          </ul>
        ) : (
          <p className="type-fine text-muted-foreground">Ходов нет.</p>
        )}
      </Section>
    </Document>
  );
}

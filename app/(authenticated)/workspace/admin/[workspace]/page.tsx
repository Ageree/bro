import type { Metadata } from "next";
import Link from "next/link";
import { env } from "@shared/environment";
import {
  Document,
  DocumentTitle,
  Rows,
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
  const workspaceId = decodeWorkspace(workspace);
  const failedOnly = failed === "1";
  // The guard runs inside the query, so a bad parameter is a 404 only for
  // the owner; anyone else gets the same 404 before the parameter is read.
  const { label, limit, turns } = await adminQuery((admin) =>
    admin.turns({ failedOnly, workspaceId })
  );
  const base = `/workspace/admin/${encodeURIComponent(workspaceId)}`;

  return (
    <Document>
      <DocumentTitle>{label}</DocumentTitle>
      <p className="type-status text-muted-foreground">
        <Link className="bro-link" href="/workspace/admin">
          ← Все люди
        </Link>
      </p>
      <Section
        headingId="admin-turns-heading"
        state={
          turns.length >= limit
            ? `последние ${String(limit)}`
            : `${String(turns.length)} за 30 дней`
        }
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
          <Rows>
            {turns.map((turn) => (
              <TurnRow
                key={turn.id}
                textsOn={env.OWNER_TRANSCRIPTS === "on"}
                turn={turn}
              />
            ))}
          </Rows>
        ) : (
          <p className="type-fine text-muted-foreground">Ходов нет.</p>
        )}
      </Section>
    </Document>
  );
}

/** A malformed `%` escape decodes to nothing, which the procedure refuses. */
function decodeWorkspace(segment: string) {
  try {
    return decodeURIComponent(segment);
  } catch {
    return "";
  }
}

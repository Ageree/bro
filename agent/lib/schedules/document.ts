import { micromark } from "micromark";
import { gfmTable, gfmTableHtml } from "micromark-extension-gfm-table";
import type { ScheduledRunOutcome } from "@shared/schedules/outcome";
import { localRunLabel } from "@shared/schedules/timing";

function escapeHtml(value: string) {
  return value.replace(/[&<>"']/gu, (character) => {
    switch (character) {
      case "&":
        return "&amp;";
      case "<":
        return "&lt;";
      case ">":
        return "&gt;";
      case '"':
        return "&quot;";
      default:
        return "&#39;";
    }
  });
}

function renderMarkdown(value: string) {
  return micromark(value, {
    extensions: [gfmTable(), { disable: { null: ["labelStartImage"] } }],
    htmlExtensions: [gfmTableHtml()],
  }).replace(/ href="(?!https?:\/\/)[^"]*"/giu, "");
}

export function scheduledResultDocument(input: {
  readonly outcome: Extract<ScheduledRunOutcome, { kind: "result" }>;
  readonly scheduledFor: Date;
  readonly timezone?: string;
}) {
  const { outcome } = input;
  const dateLabel = input.timezone
    ? localRunLabel(input.scheduledFor, input.timezone)
    : `${input.scheduledFor.toISOString()} (UTC)`;
  return `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'">
<meta name="referrer" content="no-referrer">
<title>bro</title>
<style>
:root{color-scheme:light;--paper:#f7f3eb;--ink:#252a28;--muted:#626960;--line:#d7d9cc;--accent:#2d5943}
*{box-sizing:border-box}body{margin:0;background:var(--paper);color:var(--ink);font:18px/1.7 system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;overflow-wrap:anywhere}
main{max-width:840px;margin:48px auto;padding:0 32px 64px}header{display:flex;align-items:baseline;justify-content:space-between;flex-wrap:wrap;gap:12px 24px;border-bottom:1px solid var(--line);padding-bottom:24px;margin-bottom:36px}.brand{color:var(--accent);font-size:24px;font-weight:700;letter-spacing:-.04em}
h1,h2,h3,h4,h5,h6{line-height:1.25;text-wrap:balance}h1{font-size:clamp(30px,5vw,44px);letter-spacing:-.035em;margin:16px 0 24px}h2{font-size:28px;margin:44px 0 18px;padding-bottom:12px;border-bottom:1px solid var(--line)}h3{font-size:22px;margin:32px 0 14px}p{margin:16px 0}header p{color:var(--muted)}time{font-size:14px;color:var(--muted)}a{color:var(--accent);text-underline-offset:.18em}li+li{margin-top:8px}ul,ol{padding-left:26px}
blockquote{margin:24px 0;padding:4px 24px;border-left:3px solid var(--accent);background:#eeeee3}table{display:block;width:100%;overflow-x:auto;border-collapse:collapse;font-size:15px;margin:24px 0}th,td{border:1px solid var(--line);padding:12px 16px;text-align:left;vertical-align:top}th{background:#e8ecdf;font-weight:650}tbody tr:nth-child(even){background:#f0f0e6}
pre{white-space:pre-wrap;overflow-wrap:anywhere;background:#eeeee5;padding:20px;border-radius:8px;font-size:13px;line-height:1.65}code{font-family:ui-monospace,SFMono-Regular,Consolas,monospace}p code,li code{background:#eeeee5;padding:2px 5px;border-radius:4px}hr{border:0;border-top:1px solid var(--line);margin:36px 0}article>section{margin-top:40px;padding-top:16px;border-top:1px solid var(--line)}
@media(max-width:600px){body{font-size:16px}main{margin:24px auto;padding:0 20px 40px}h2{font-size:24px}th,td{padding:9px 12px}}
@media print{body{background:#fff;color:#000;font-size:11pt}main{max-width:none;margin:0;padding:0}h1,h2,h3,h4,h5,h6{break-after:avoid}tr,blockquote{break-inside:avoid}table{display:table;font-size:9pt}a{color:inherit}@page{margin:18mm}}
</style>
</head>
<body>
<main>
<header><div class="brand">bro</div><time datetime="${input.scheduledFor.toISOString()}">${escapeHtml(dateLabel)}</time></header>
<article>${renderMarkdown(outcome.summary)}${outcome.details ? `<section>${renderMarkdown(outcome.details)}</section>` : ""}</article>
</main>
</body>
</html>`;
}

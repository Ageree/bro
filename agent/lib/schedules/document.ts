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
  })
    .replace(/ href="(?!https?:\/\/)[^"]*"/giu, "")
    .replaceAll("<table>", '<div class="table-scroll"><table>')
    .replaceAll("</table>", "</table></div>");
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
:root{color-scheme:light;--background:#f1f2ee;--foreground:#141510;--card:#fff;--secondary:#e7e8e2;--muted-foreground:#6a6c62;--bro-line:#d2d4cb;--bro-family-display:"Source Serif 4",Georgia,"Times New Roman",serif;--bro-family-text:Geist,system-ui,-apple-system,sans-serif}
*{box-sizing:border-box}body{margin:0;background:var(--background);color:var(--foreground);font:400 16px/24px var(--bro-family-text);overflow-wrap:anywhere;-webkit-font-smoothing:antialiased}
main{max-width:816px;margin:32px auto;padding:0 32px 64px}.bro-plate{overflow:hidden;background:var(--card);border:2px solid var(--foreground);border-radius:24px;box-shadow:0 8px 30px rgb(20 21 16 / 8%)}.bro-plate:before{content:"";display:block;height:8px;background:var(--secondary)}.card-content{padding:24px}
header{display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:12px 16px;margin-bottom:24px}.brand{font-size:20px;line-height:20px;font-weight:600;letter-spacing:-.04em}.metadata{max-width:100%;padding:4px 12px;border-radius:999px;background:var(--secondary);color:var(--muted-foreground);font-size:12px;line-height:16px;font-weight:600}
h1,h2,h3,h4,h5,h6{font-family:var(--bro-family-display);font-weight:400;letter-spacing:0;text-wrap:balance}h1{font-size:28px;line-height:31px;margin:0 0 16px}h2,h3,h4,h5,h6{font-size:20px;line-height:24px;margin:32px 0 16px}p{margin:16px 0}.report-content>:first-child,section>:first-child{margin-top:0}.report-content>:last-child,section>:last-child{margin-bottom:0}strong{font-weight:600}a{color:inherit;text-underline-offset:4px}a:focus-visible{outline:2px solid var(--foreground);outline-offset:4px}
ul,ol{padding-left:24px;margin:16px 0;font-size:15px;line-height:22px}li{padding:12px 0}li+li{border-top:1px solid var(--bro-line)}li>p{margin:0}li>p+p{margin-top:8px}li>ul,li>ol{margin:8px 0 0}blockquote{margin:24px 0;padding:16px;border:1px solid var(--bro-line);border-radius:16px;background:var(--secondary)}blockquote>:first-child{margin-top:0}blockquote>:last-child{margin-bottom:0}
.table-scroll{overflow-x:auto;margin:24px 0}table{width:100%;border-collapse:separate;border-spacing:0;font-size:15px;line-height:22px}th,td{min-width:120px;border:0;border-bottom:1px solid var(--bro-line);padding:12px 8px;text-align:left;vertical-align:top}th{color:var(--muted-foreground);font-size:12px;line-height:16px;font-weight:600}tbody tr:last-child td{border-bottom:0}
pre{white-space:pre-wrap;overflow-wrap:anywhere;background:var(--secondary);padding:16px;border-radius:16px;font-size:12px;line-height:20px}code{font-family:ui-monospace,SFMono-Regular,Consolas,monospace}:not(pre)>code{background:var(--secondary);padding:0 4px;border-radius:4px}hr{border:0;border-top:1px solid var(--bro-line);margin:24px 0}.report-content>section{margin-top:24px;padding-top:24px;border-top:1px solid var(--bro-line)}
@media(max-width:600px){main{margin:16px auto;padding:0 16px 32px}.card-content{padding:24px 16px}header{align-items:flex-start;flex-direction:column;gap:12px}}
@media print{body{background:#fff}main{max-width:none;margin:0;padding:0}.bro-plate{overflow:visible;box-shadow:none;box-decoration-break:clone;-webkit-box-decoration-break:clone}.bro-plate:before{display:none}.card-content{padding:24px}h1,h2,h3,h4,h5,h6{break-after:avoid}p,li{orphans:3;widows:3}tr{break-inside:avoid}.table-scroll{overflow:visible}table{table-layout:fixed}th,td{min-width:0;overflow-wrap:anywhere}thead{display:table-header-group}pre,blockquote{background:none}a{color:inherit}@page{size:A4;margin:16mm}}
</style>
</head>
<body>
<main>
<article class="bro-plate" data-tone="neutral">
<div class="card-content">
<header><div class="brand">bro</div><time class="metadata" datetime="${input.scheduledFor.toISOString()}">${escapeHtml(dateLabel)}</time></header>
<div class="report-content">${renderMarkdown(outcome.summary)}${outcome.details ? `<section>${renderMarkdown(outcome.details)}</section>` : ""}</div>
</div>
</article>
</main>
</body>
</html>`;
}

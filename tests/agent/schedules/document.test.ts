import { readFileSync } from "node:fs";
import { parseHTML } from "linkedom";
import { describe, expect, it } from "vitest";
import { scheduledResultDocument } from "@agent/lib/schedules/document";

const scheduledFor = new Date("2026-10-30T12:00:00.000Z");

describe("scheduled result document", () => {
  it("uses Bro's neutral plate, typography, chip and internal divider recipes offline", () => {
    const { document } = parseHTML(
      scheduledResultDocument({
        outcome: {
          kind: "result",
          summary: "# Report\n\n## Section\n\nAll of the content.",
          urgency: "normal",
        },
        scheduledFor,
      })
    );
    const css = document.querySelector("style")?.textContent ?? "";
    const foundation = readFileSync(
      new URL("../../../app/styles/brand/foundation.css", import.meta.url),
      "utf8"
    );
    const brand = readFileSync(
      new URL("../../../app/styles/brand/bro.css", import.meta.url),
      "utf8"
    );
    for (const token of [
      "background",
      "foreground",
      "card",
      "secondary",
      "muted-foreground",
    ]) {
      const value =
        new RegExp(`--${token}:\\s*([^;]+);`, "u").exec(foundation)?.[1] ?? "";
      expect(value).toBeTruthy();
      expect(css).toContain(`--${token}:${value};`);
    }
    expect(css).toContain(
      `--bro-line:${/--color-bro-line:\s*([^;]+);/u.exec(brand)?.[1] ?? ""};`
    );
    const plate = /@utility bro-plate \{([^}]+)\}/u.exec(brand)?.[1];
    expect(plate).toBeTruthy();
    for (const declaration of plate?.trim().split(";").filter(Boolean) ?? []) {
      expect(css.replaceAll(/\s/gu, "")).toContain(
        declaration
          .replaceAll("--color-", "--")
          .replaceAll("1.5rem", "24px")
          .replaceAll(/\s/gu, "")
      );
    }
    expect(css).toContain(
      '--bro-family-display:"Source Serif 4",Georgia,"Times New Roman",serif'
    );
    expect(css).toContain(
      "--bro-family-text:Geist,system-ui,-apple-system,sans-serif"
    );
    expect(css).toContain("font:400 16px/24px var(--bro-family-text)");
    expect(css).toContain(
      "font-family:var(--bro-family-display);font-weight:400"
    );
    expect(css).toContain("h1{font-size:28px;line-height:31px");
    expect(css).toContain("h2,h3,h4,h5,h6{font-size:20px;line-height:24px");
    expect(css).toContain("border-radius:999px");
    expect(css).toContain("font-size:12px;line-height:16px;font-weight:600");
    expect(css).toContain("border-top:1px solid var(--bro-line)");
    expect(css).toContain(".table-scroll{overflow-x:auto");
    expect(css).toContain(".table-scroll{overflow:visible}");
    expect(
      document.querySelector("article.bro-plate[data-tone=neutral]")
    ).not.toBeNull();
    expect(
      document.querySelector(".card-content>header time.metadata")
    ).not.toBeNull();
    expect(document.querySelector(".report-content>h1")?.textContent).toBe(
      "Report"
    );
    expect(css).not.toMatch(/@import|url\(/iu);
    expect(
      document.querySelectorAll("button,input,select,textarea")
    ).toHaveLength(0);
  });

  it("renders headings, lists, tables and real source links with the full end", () => {
    const summary = `# Обзор 🧭\n\n## Раздел\n\n${"Кириллица и emoji 🚀. ".repeat(500)}\n\n- Первый\n- Второй\n\n| Источник | Итог |\n| --- | --- |\n| [Публикация](https://example.com/source?a=1&b=2) | Готово |\n\nФИНАЛЬНЫЙ_SENTINEL_🏁`;
    const outcome = {
      artifacts: [
        {
          id: "00000000-0000-4000-8000-000000000099",
          label: "Internal artifact",
        },
      ],
      details: "## Дополнение\n\nПоследняя деталь 🔚.",
      expiresAt: "2026-11-01T12:00:00Z",
      kind: "result" as const,
      summary,
      urgency: "normal" as const,
    };
    const html = scheduledResultDocument({
      outcome,
      scheduledFor,
    });
    const { document } = parseHTML(html);

    expect(document.querySelector("article h1")?.textContent).toBe("Обзор 🧭");
    expect(document.querySelector("article h2")?.textContent).toBe("Раздел");
    expect(document.querySelectorAll("li")).toHaveLength(2);
    expect(document.querySelectorAll("table tbody td")).toHaveLength(2);
    expect(document.querySelectorAll(".table-scroll>table")).toHaveLength(1);
    expect(document.querySelector("a")?.getAttribute("href")).toBe(
      "https://example.com/source?a=1&b=2"
    );
    expect(document.querySelector("article")?.textContent).toContain(
      "ФИНАЛЬНЫЙ_SENTINEL_🏁"
    );
    expect(document.querySelector("article")?.textContent).toContain(
      "Последняя деталь 🔚."
    );
    expect(document.querySelectorAll("h1")).toHaveLength(1);
    expect(document.querySelector("header")?.textContent).toContain("bro");
    expect(document.querySelector("header h1")).toBeNull();
    expect(document.querySelector("html")?.hasAttribute("lang")).toBe(false);
    expect(html).not.toContain("00000000-0000-4000-8000-000000000099");
    expect(html).not.toContain("Internal artifact");
    expect(html).not.toContain("2026-11-01");
    expect(html).not.toContain('"kind": "result"');
    expect(document.querySelector("time")?.textContent).toBe(
      "2026-10-30T12:00:00.000Z (UTC)"
    );
    expect(html).toContain("@media(max-width:600px)");
    expect(html).toContain("@media print");
    expect(document.querySelector("meta[name=viewport]")).not.toBeNull();
  });

  it("does not impose hosted-card limits on report sections, list items or table data", () => {
    const sections = Array.from(
      { length: 20 },
      (_, index) =>
        `## Section ${String(index + 1)}\n\n${"Full report text. ".repeat(20)}`
    ).join("\n\n");
    const items = Array.from(
      { length: 20 },
      (_, index) => `- Item ${String(index + 1)}`
    ).join("\n");
    const rows = Array.from(
      { length: 20 },
      (_, index) => `| Row ${String(index + 1)} | A | B | C | D | E |`
    ).join("\n");
    const { document } = parseHTML(
      scheduledResultDocument({
        outcome: {
          kind: "result",
          summary: `${sections}\n\n${items}\n\n| One | Two | Three | Four | Five | Six |\n| --- | --- | --- | --- | --- | --- |\n${rows}\n\nFULL_END_SENTINEL`,
          details: "## Final appendix\n\nAPPENDIX_END_SENTINEL",
          urgency: "normal",
        },
        scheduledFor,
      })
    );
    expect(document.querySelectorAll("h2")).toHaveLength(21);
    expect(document.querySelectorAll("li")).toHaveLength(20);
    expect(document.querySelectorAll("table th")).toHaveLength(6);
    expect(document.querySelectorAll("table tbody tr")).toHaveLength(20);
    expect(document.querySelector("article")?.textContent).toContain(
      "FULL_END_SENTINEL"
    );
    expect(
      document.querySelector("article")?.textContent.length
    ).toBeGreaterThan(4000);
    expect(
      document
        .querySelector("article")
        ?.textContent.trim()
        .endsWith("APPENDIX_END_SENTINEL")
    ).toBe(true);
    expect(document.querySelector("style")?.textContent).not.toMatch(
      /line-clamp|max-height|text-overflow/iu
    );
  });

  it("escapes raw HTML and blocks scripts, dangerous URLs and all images", () => {
    const summary = [
      '<script>alert("xss")</script>',
      '<img src="https://example.com/track" onerror="alert(1)">',
      '<iframe src="https://example.com/frame"></iframe>',
      "<style>body{background:url(https://example.com/track)}</style>",
      "[JS](javascript:alert%281%29)",
      "[Encoded JS](jav&#x61;script:alert%281%29)",
      "[Data](data:text/html,evil)",
      "[Local](file:///etc/passwd)",
      "[Relative](//example.com/track)",
      "![Alt 🧭](https://example.com/picture.png)",
      "![Data image](data:image/svg+xml,evil)",
      "[Source](https://example.com/source)",
      "[Uppercase](HTTPS://example.com/upper)",
      "[HTTP source](HTTP://example.com/http-source)",
    ].join("\n\n");
    const outcome = {
      kind: "result" as const,
      summary,
      urgency: "normal" as const,
    };
    const { document } = parseHTML(
      scheduledResultDocument({
        outcome,
        scheduledFor,
      })
    );

    expect(
      document.querySelectorAll("script,img,iframe,object,embed,link,form,base")
    ).toHaveLength(0);
    expect(document.querySelectorAll("style")).toHaveLength(1);
    expect(
      [...document.querySelectorAll("a[href]")].map((link) =>
        link.getAttribute("href")
      )
    ).toEqual([
      "https://example.com/picture.png",
      "https://example.com/source",
      "HTTPS://example.com/upper",
      "HTTP://example.com/http-source",
    ]);
    expect(document.querySelector("article")?.textContent).toContain(
      '<script>alert("xss")</script>'
    );
    expect(document.querySelector("article")?.textContent).toContain("Alt 🧭");
    expect(document.querySelector("article")?.textContent).toContain(
      "Data image"
    );
    expect(
      document
        .querySelector('meta[http-equiv="Content-Security-Policy"]')
        ?.getAttribute("content")
    ).toBe(
      "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'"
    );
  });

  it("uses the schedule's timezone without imposing a content language or another title", () => {
    const { document } = parseHTML(
      scheduledResultDocument({
        outcome: {
          kind: "result",
          summary: "# Research report\n\nComplete results.",
          details: "## More details\n\nEverything is here.",
          urgency: "normal",
        },
        scheduledFor,
        timezone: "America/New_York",
      })
    );
    expect(document.querySelector("time")?.textContent).toBe(
      "2026-10-30 08:00, Friday (America/New_York)"
    );
    expect(document.querySelectorAll("h1")).toHaveLength(1);
    expect(document.querySelector("h1")?.textContent).toBe("Research report");
    expect(document.querySelector("body")?.textContent).not.toMatch(
      /[А-Яа-яЁё]/u
    );
  });

  it("keeps image descriptions and source URLs without loading images", () => {
    const { document } = parseHTML(
      scheduledResultDocument({
        outcome: {
          kind: "result",
          summary:
            '![Chart: revenue & growth 🧭](https://example.com/graph.svg?year=2026&lang=en "Original chart")',
          urgency: "normal",
        },
        scheduledFor,
      })
    );
    expect(document.querySelectorAll("img")).toHaveLength(0);
    expect(document.querySelector("article")?.textContent).toContain(
      "Chart: revenue & growth 🧭"
    );
    expect(document.querySelector("article a")?.getAttribute("href")).toBe(
      "https://example.com/graph.svg?year=2026&lang=en"
    );
    expect(document.querySelector("article a")?.getAttribute("title")).toBe(
      "Original chart"
    );
  });
});

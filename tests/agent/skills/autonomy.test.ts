import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  fullDeployment,
  stubDeployment,
  systemPrompt,
  turnKinds,
} from "@tests/helpers/system-prompt";

// What the resolvers read of a workspace: no limit, Moscow, «ты», and
// other chats.
vi.mock("@db/services/spending", () => ({
  listSpendEntries: async () => [],
  readSpendLimit: async () => undefined,
}));
vi.mock("@db/services/user-profile", () => ({
  readWorkspaceTimeZone: async () => "Europe/Moscow",
}));
vi.mock("@db/services/settings", () => ({
  getFormOfAddress: async () => ({ kind: "ty" }),
}));
vi.mock("@db/services/chats", () => ({
  hasOtherConversations: async () => true,
}));

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-10-02T09:41:00Z"));
});

afterEach(() => {
  vi.useRealTimers();
});

const content = new URL(
  "../../../agent/instructions/content/",
  import.meta.url
);

/** Tokens as `scripts/costs/step-context.ts` estimates instructions. */
const tokens = (text: string) => text.length / 3.1;

async function edits() {
  const { autonomyEdits } = await import("@agent/lib/skills/autonomy");
  return autonomyEdits;
}

describe("the autonomy pilot's instructions", () => {
  it("replace text that stands in its file exactly once", async () => {
    for (const edit of await edits()) {
      const text = readFileSync(new URL(`${edit.source}.md`, content), "utf8");
      expect(text.split(edit.from).length - 1, edit.from).toBe(1);
      expect(edit.to).not.toBe(edit.from);
    }
  });

  it("read the edits in the pilot's full prompt, and the old text elsewhere", async () => {
    stubDeployment({
      ...fullDeployment,
      ERRAND_AUTONOMY_WORKSPACES: "workspace-1",
    });
    const pilot = await systemPrompt(turnKinds.interactive);
    stubDeployment({
      ...fullDeployment,
      ERRAND_AUTONOMY_WORKSPACES: "workspace-2",
    });
    const other = await systemPrompt(turnKinds.interactive);

    for (const edit of await edits()) {
      expect(pilot).toContain(edit.to);
      expect(pilot).not.toContain(edit.from);
      expect(other).toContain(edit.from);
      expect(other).not.toContain(edit.to);
    }
  });

  it("leave the skills pilot's core as it is, within its budget", async () => {
    stubDeployment({ ...fullDeployment, SKILLS_WORKSPACES: "workspace-1" });
    const core = await systemPrompt(turnKinds.interactive);
    stubDeployment({
      ...fullDeployment,
      ERRAND_AUTONOMY_WORKSPACES: "*",
      SKILLS_WORKSPACES: "workspace-1",
    });

    expect(await systemPrompt(turnKinds.interactive)).toBe(core);
    expect(tokens(core)).toBeLessThanOrEqual(10_000);
  });

  it("put the edits in the skill bodies of the pilot", async () => {
    stubDeployment(fullDeployment);
    const { skillBody } = await import("@agent/lib/skills/catalog");
    const setup = { browser: true, images: false };
    const fines =
      "проверяй сам, без карточки и вопроса: поручение на официальном сайте ГИБДД";
    const fallback = "Это то же поручение, и нового слова человека не жди";

    expect(skillBody("gov-services", setup)).not.toContain(fines);
    expect(skillBody("browser", setup)).not.toContain(fallback);
    expect(skillBody("gov-services", { ...setup, autonomy: true })).toContain(
      fines
    );
    expect(skillBody("browser", { ...setup, autonomy: true })).toContain(
      fallback
    );
  });
});

describe("the autonomy pilot's checks", () => {
  it("knows a site the person named, in Cyrillic or Latin", async () => {
    stubDeployment({});
    const { namesSite, personSiteWords } =
      await import("@agent/lib/browser-use/autonomy");

    const named = personSiteWords(["Закажи на Озоне корм для кошки"]);
    expect(namesSite(named, "ozon.ru")).toBe(true);
    expect(
      namesSite(personSiteWords(["посмотри на avito.ru"]), "avito.ru")
    ).toBe(true);
    expect(
      namesSite(personSiteWords(["найди в Яндекс Маркете"]), "yandex.ru")
    ).toBe(true);
    expect(
      namesSite(
        personSiteWords(["запиши меня к барберу на завтра"]),
        "topgun.ru"
      )
    ).toBe(false);
    expect(namesSite(named, "wildberries.ru")).toBe(false);
  });

  it("finds the numbers of a СТС and a licence with the word that names them", async () => {
    stubDeployment({});
    const { carriesVehicleDocumentNumbers, checksFinesOfficially } =
      await import("@agent/lib/browser-use/public-services");

    expect(
      carriesVehicleDocumentNumbers(["Проверь штрафы: СТС 77 УО 123456"])
    ).toBe(true);
    expect(carriesVehicleDocumentNumbers(["штрафы по ВУ 9912345678"])).toBe(
      true
    );
    // A phone or a bare number is not a document.
    expect(
      carriesVehicleDocumentNumbers(["позвони в сервис, телефон 9161234567"])
    ).toBe(false);
    expect(carriesVehicleDocumentNumbers(["СТС у меня есть"])).toBe(false);

    expect(checksFinesOfficially("https://xn--90adear.xn--p1ai")).toBe(true);
    expect(checksFinesOfficially("https://гибдд.рф/check/fines")).toBe(true);
    expect(checksFinesOfficially("https://www.gosuslugi.ru")).toBe(true);
    expect(checksFinesOfficially("https://shtrafy-gibdd.ru")).toBe(false);
    expect(checksFinesOfficially("https://xn--90adear.xn--p1ai.evil.ru")).toBe(
      false
    );
  });

  it("sends fines to the ГИБДД check when Госуслуги would not let the errand in", async () => {
    stubDeployment({});
    const { gosuslugiFallback } =
      await import("@agent/lib/browser-use/public-services");
    const site = "https://www.gosuslugi.ru";
    const errand = "Проверь штрафы и налоги";

    expect(gosuslugiFallback(site, errand)).toContain(
      "where the user types the numbers themselves"
    );
    expect(gosuslugiFallback(site, errand, true)).toContain(
      "start the check on the ГИБДД site (site https://xn--90adear.xn--p1ai)"
    );
  });
});

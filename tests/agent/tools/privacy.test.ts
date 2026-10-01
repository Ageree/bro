import type { DynamicResolveContext, ToolContext } from "eve/tools";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  getGoogleWorkspaceAccess,
  getWorkspaceModelId,
} from "@db/services/settings";
import { googleWorkspaceRetainedData } from "@shared/google-workspace/connection";
import { accessScopeForUser } from "@shared/identity/access-scope";
import { browserVmTestEnvironment } from "@tests/helpers/browser-vm";
import { type FakeComposio, fakeComposio } from "@tests/helpers/composio";

const settings = vi.hoisted(() => ({
  access: vi.fn<typeof getGoogleWorkspaceAccess>(),
  model: vi.fn<typeof getWorkspaceModelId>(),
}));

vi.mock("@db/services/settings", () => ({
  getGoogleWorkspaceAccess: settings.access,
  getWorkspaceModelId: settings.model,
}));

import privacyTools, { privacy } from "@agent/tools/privacy";
import {
  googleAccessOptions,
  restrictsSending,
  ruleAccessNote,
} from "@agent/lib/privacy/google-access";

const scope = accessScopeForUser("better-auth:user-1");

let composio: FakeComposio;

beforeEach(() => {
  vi.clearAllMocks();
  composio = fakeComposio();
  settings.access.mockResolvedValue("full");
  settings.model.mockResolvedValue("deepseek/deepseek-v4.1-flash");
});

afterEach(() => {
  vi.unstubAllGlobals();
  // Only this file's stubs are undone; the suite's own environment stays.
  for (const name of optionalServices) vi.stubEnv(name, undefined);
});

const optionalServices = [
  "BROWSER_USE_API_KEY",
  "BROWSER_USE_PROXY_HOST",
  "BROWSER_USE_PROXY_PORT",
  "BROWSER_USE_SIGN_IN_REFRESH_DAYS",
  "BROWSER_VM_LLM_API_KEY",
  "BROWSER_VM_PROXY",
  "BROWSER_VM_SIGNING_KEY",
  "CLOUDRU_BROWSER_IMAGE",
  "CLOUDRU_KEY_ID",
  "CLOUDRU_KEY_SECRET",
  "IMESSAGE_PROJECT_ID",
  "IMESSAGE_PROJECT_SECRET",
  "MODEL_PROVIDER",
  "OPENROUTER_API_KEY",
  "ROUTERAI_API_KEY",
  "SUPERMEMORY_API_KEY",
  "TELEGRAM_BOT_TOKEN",
  "YOOKASSA_SECRET_KEY",
  "YOOKASSA_SHOP_ID",
] as const;

/**
 * The privacy modules as a deployment with exactly these optional services
 * reads them: the environment is parsed once, when a module first loads.
 */
async function withServices(
  services: Partial<Record<(typeof optionalServices)[number], string>>
) {
  for (const name of optionalServices) vi.stubEnv(name, services[name] ?? "");
  vi.resetModules();
  return {
    facts: await import("@agent/lib/privacy/facts"),
    tool: (await import("@agent/tools/privacy")).privacy,
  };
}

/**
 * RU d14 (25.09): asked «что у тебя осталось из моих данных и где они
 * хранятся?», Bro said «в облаке сервиса» and «Postgres в облаке», and named
 * neither the language model's provider, nor the cloud browser, nor how to
 * switch Google off.
 */
describe("privacy", () => {
  it("is offered in a conversation, never to a background run", async () => {
    const resolve = privacyTools.events["turn.started"];
    if (!resolve) throw new Error("Expected a turn resolver.");
    const tools = await resolve({}, dynamicContext("telegram-webhook"));
    expect(tools && !("execute" in tools) ? Object.keys(tools) : []).toEqual([
      "privacy",
    ]);
    expect(await resolve({}, dynamicContext("scheduled-worker"))).toBeNull();
    expect(await resolve({}, dynamicContext("scheduled-result"))).toBeNull();
  });

  it("names where the data lives, who processes it, what is unknown and how each part goes", async () => {
    const { tool } = await withServices({
      BROWSER_USE_API_KEY: "browser-use-test-key",
      OPENROUTER_API_KEY: "openrouter-test-key",
    });
    composio.connect({
      displayName: "ada@example.com",
      toolkit: "googlesuper",
    });

    const result = await overview(tool);

    expect(result.kept.join("\n")).toMatch(/Postgres в Neon/u);
    expect(result.kept.join("\n")).toMatch(/Vercel Blob/u);
    expect(result.kept.join("\n")).toMatch(/AES-256-GCM/u);
    const processors = result.processors.join("\n");
    expect(processors).toContain("deepseek/deepseek-v4.1-flash");
    expect(processors).toContain("OpenRouter");
    expect(processors).toContain("Browser Use");
    expect(processors).toContain("Composio");
    // No guessed country: the settings name none.
    expect(result.serverLocation).toContain("не знает");
    expect(result.google).toBe(googleAccessOptions("full"));
    const remove = result.remove.join("\n");
    expect(remove).toContain("«удали всё, что ты про меня помнишь»");
    expect(remove).toContain("«отключи Google»");
    expect(remove).toContain("В самом Google ничего не удаляется");
    expect(remove).toContain("https://example.com/personal-info");
    expect(remove).toContain("https://example.com/vault");
    expect(remove).toContain("«останови все расписания»");
    expect(result.reply).toContain("Do not ask whether to delete");
    // The sign-ins Bro keeps, the visits it makes on its own, and how both
    // end (review of wave 6).
    expect(result.kept.join("\n")).toContain(
      "сайты, где облачный браузер держит вход, со ссылкой на страницу аккаунта на каждом"
    );
    expect(processors).toContain(
      "Чтобы вход не пропадал, раз в 3 дн. облачный браузер сам, без поручения, открывает страницу аккаунта"
    );
    expect(remove).toContain("«забудь мои входы на сайты»");
    expect(remove).toContain("«не заходи больше в <сайт>»");
  });

  it("names RouterAI, not OpenRouter, once the model runs there", async () => {
    const { facts } = await withServices({
      MODEL_PROVIDER: "routerai",
      OPENROUTER_API_KEY: "openrouter-test-key",
      ROUTERAI_API_KEY: "routerai-test-key",
    });
    const processors = facts
      .dataProcessors("deepseek/deepseek-v4.1-flash")
      .join("\n");

    expect(processors).toContain(
      "языковая модель deepseek/deepseek-v4.1-flash: запрос идёт через RouterAI"
    );
    expect(processors).toContain("веб-поиска RouterAI передаёт поисковикам");
    expect(processors).not.toContain("OpenRouter");
    expect(processors).not.toContain("Vercel AI Gateway");
  });

  it("says nothing of visits the deployment does not make", async () => {
    const { facts } = await withServices({
      BROWSER_USE_API_KEY: "browser-use-test-key",
      BROWSER_USE_SIGN_IN_REFRESH_DAYS: "0",
    });

    expect(
      facts.dataProcessors("deepseek/deepseek-v4.1-flash").join("\n")
    ).not.toContain("без поручения");
    // The sign-ins themselves are still kept, and still said.
    expect(facts.keptData().join("\n")).toContain("держит вход");
  });

  it("tells what stays once Google is off, and that nothing in Google was deleted", async () => {
    const result = await overview(privacy);

    expect(result.google).toContain("Google не подключён");
    expect(result.google).toContain("В самом Google");
    expect(result.google).toContain(googleWorkspaceRetainedData);
  });

  it("names the model the workspace runs on, and only the services in use", async () => {
    const { facts } = await withServices({});
    const processors = facts
      .dataProcessors("openai/gpt-5.6-sol-fast")
      .join("\n");

    expect(processors).toContain("openai/gpt-5.6-sol-fast");
    expect(processors).toContain("Vercel AI Gateway");
    expect(processors).not.toContain("Browser Use");
    expect(processors).not.toContain("Supermemory");
    expect(processors).not.toContain("ЮKassa");
    expect(processors).not.toContain("прокси");
    expect(processors).not.toContain("Photon");
    expect(processors).not.toContain("Telegram");
    expect(facts.keptData().join("\n")).not.toContain("оплат");
    expect(facts.keptData().join("\n")).not.toContain("держит вход");
  });

  // Review of wave 5: with billing on, the payment processor was missing
  // from a list the model is told to retell as complete.
  it("names every configured processor: payments, the browser's proxy, the messengers and the sign-in code", async () => {
    const { facts } = await withServices({
      BROWSER_USE_API_KEY: "browser-use-test-key",
      BROWSER_USE_PROXY_HOST: "proxy.example",
      BROWSER_USE_PROXY_PORT: "8080",
      IMESSAGE_PROJECT_ID: "photon-project",
      IMESSAGE_PROJECT_SECRET: "photon-secret",
      OPENROUTER_API_KEY: "openrouter-test-key",
      TELEGRAM_BOT_TOKEN: "telegram-token",
      YOOKASSA_SECRET_KEY: "yookassa-secret",
      YOOKASSA_SHOP_ID: "yookassa-shop",
    });
    const processors = facts
      .dataProcessors("deepseek/deepseek-v4.1-flash")
      .join("\n");

    expect(processors).toContain("ЮKassa");
    expect(processors).toContain("данные карты Бро не видит");
    expect(processors).toContain("прокси-сервер деплоя");
    expect(processors).toContain("Exa и Perplexity");
    expect(processors).toContain("Telegram и iMessage (через сервис Photon)");
    expect(processors).toContain("Код для входа по номеру телефона");
    expect(facts.keptData().join("\n")).toContain("история оплат подписки");
  });

  it("names the browser VMs' cloud and zone, their model service and their proxy", async () => {
    const { facts } = await withServices({
      ...browserVmTestEnvironment,
      BROWSER_VM_PROXY:
        "premium-residential.geonode.com:9000:geonode_bro-session-{session}:secret",
    });
    const processors = facts
      .dataProcessors("deepseek/deepseek-v4.1-flash")
      .join("\n");

    expect(processors).toContain("Cloud.ru (зона ru.AZ-3, Россия)");
    expect(processors).toContain("профиль браузера с куки сайтов");
    expect(processors).toContain(
      "языковая модель deepseek/deepseek-v4.1-flash через RouterAI"
    );
    expect(processors).toContain("резидентный прокси Geonode");
    // Only the backend this deployment has is named.
    expect(processors).not.toContain("Browser Use");
    expect(processors).not.toContain("прокси-сервер деплоя");
    expect(processors).toContain("раз в 3 дн. облачный браузер сам");
    expect(facts.keptData().join("\n")).toContain("держит вход");
    // The zone is a setting, so the VMs' country is known; the rest is not.
    expect(facts.serverLocation()).toContain("Cloud.ru (зона ru.AZ-3, Россия)");
    expect(facts.serverLocation()).toContain(
      "остальных сервисов, Бро не знает"
    );
  });

  it("says nothing of browser VMs a deployment without them does not have", async () => {
    const { facts } = await withServices({
      BROWSER_USE_API_KEY: "browser-use-test-key",
    });

    expect(
      facts.dataProcessors("deepseek/deepseek-v4.1-flash").join("\n")
    ).not.toContain("Cloud.ru");
    expect(facts.serverLocation()).not.toContain("Cloud.ru");
    expect(facts.serverLocation()).toContain(
      "регион нигде в его настройках не записан"
    );
  });
});

describe("offering read-only Google", () => {
  it.each([
    "никогда ничего не оплачивай и никому не пиши без моего ок",
    "Никогда ничего не оплачивать и никому не писать без моего ок.",
    "ничего не отправляй без спроса",
    "письма отправляй только с моего разрешения",
    "не трогай рабочую почту",
    "never email anyone without asking me",
  ])("hears «%s» as a rule against sending", (rule) => {
    expect(restrictsSending(rule)).toBe(true);
  });

  it.each([
    "никогда ничего не оплачивай без моего ок",
    "не пиши мне ночью",
    "на «вы» и без смайликов",
  ])("does not hear «%s» as one", (rule) => {
    expect(restrictsSending(rule)).toBe(false);
  });

  it("adds the offer to a no-send rule while Google is connected in full", async () => {
    composio.connect({ toolkit: "googlesuper" });

    const note = await ruleAccessNote(
      scope,
      "никогда ничего не оплачивай и никому не пиши без моего ок"
    );

    expect(note).toContain(googleAccessOptions("full"));
    expect(note).toContain("not a question to wait on");
  });

  it("says nothing when Google is not connected, already read-only, or the rule is about paying", async () => {
    const rule = "никому не пиши без моего ок";
    expect(await ruleAccessNote(scope, rule)).toBeUndefined();

    composio.connect({ toolkit: "googlesuper" });
    expect(
      await ruleAccessNote(scope, "ничего не оплачивай без моего ок")
    ).toBeUndefined();

    settings.access.mockResolvedValue("read_only");
    expect(await ruleAccessNote(scope, rule)).toBeUndefined();
  });

  it("keeps saving the rule when the Google access cannot be read", async () => {
    settings.access.mockRejectedValue(new Error("database down"));
    expect(
      await ruleAccessNote(scope, "никому не пиши без моего ок")
    ).toBeUndefined();
  });
});

/** The one result the tool answers with; it never streams. */
async function overview(tool: typeof privacy) {
  const result = await tool.execute({}, toolContext());
  if (Symbol.asyncIterator in result) {
    throw new TypeError("Expected a single result.");
  }
  return result;
}

function dynamicContext(authenticator: string): DynamicResolveContext {
  return {
    channel: { kind: "channel:telegram", metadata: {} },
    messages: [],
    model: null,
    session: {
      auth: {
        current: {
          attributes: { workspaceId: scope.workspaceId },
          authenticator,
          principalId: scope.userId,
          principalType: "user",
        },
        initiator: null,
      },
      id: "session-1",
    },
  };
}

function toolContext() {
  return focusedToolContext({
    session: {
      auth: {
        current: {
          attributes: { workspaceId: scope.workspaceId },
          authenticator: "telegram-webhook",
          principalId: scope.userId,
          principalType: "user",
        },
        initiator: null,
      },
      id: "session-1",
    },
  });
}

// oxlint-disable-next-line anti-slop/no-unknown-parameters -- This test adapter deliberately accepts a focused structural fixture.
function focusedToolContext(value: unknown): ToolContext {
  // SAFETY: The tool reads only the current session auth.
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- A complete tool context would add unrelated runtime handles.
  return value as ToolContext;
}

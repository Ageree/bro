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
  "AGENT_SANDBOX",
  "BRO_TO_BRO_WORKSPACES",
  "BROWSER_USE_API_KEY",
  "BROWSER_USE_PROXY_HOST",
  "BROWSER_USE_PROXY_PORT",
  "BROWSER_STATE_BUCKET",
  "BROWSER_USE_SIGN_IN_REFRESH_DAYS",
  "BROWSER_VM_LLM_API_KEY",
  "BROWSER_VM_PROXY",
  "BROWSER_VM_PROXY_FALLBACK",
  "BROWSER_VM_SIGNING_KEY",
  "CLOUDRU_BROWSER_IMAGE",
  "CLOUDRU_KEY_ID",
  "CLOUDRU_KEY_SECRET",
  "CLOUDRU_S3_TENANT_ID",
  "CROSS_CHANNEL_WORKSPACES",
  "IMESSAGE_PROJECT_ID",
  "IMESSAGE_PROJECT_SECRET",
  "LOCATION_WATCH_WORKSPACES",
  "LOCATION_WORKSPACES",
  "MAIL_WORKSPACES",
  "MEMORY_DIGEST_MODEL",
  "YANDEX_API_WORKSPACES",
  "MODEL_PROVIDER",
  "OPENROUTER_API_KEY",
  "OWNER_TRANSCRIPTS",
  "BROWSER_HOST_CLOUD",
  "BROWSER_HOST_STATIC",
  "ROUTERAI_API_KEY",
  "SANDBOX_HOST_ID",
  "SANDBOX_HOST_ORIGIN",
  "SANDBOX_SIGNING_KEY",
  "SANDBOX_WORKSPACES",
  "SIGN_WORKSPACES",
  "SUPERMEMORY_API_KEY",
  "TASK_FILES_WORKSPACES",
  "TASK_KIT_ROUTER_WORKSPACES",
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

    expect(result.kept.join("\n")).toMatch(/Postgres Selectel \(Россия\)/u);
    expect(result.kept.join("\n")).toMatch(/AES-256-GCM/u);
    const processors = result.processors.join("\n");
    expect(processors).toContain("deepseek/deepseek-v4.1-flash");
    expect(processors).toContain("OpenRouter");
    expect(processors).toContain("Browser Use");
    expect(processors).toContain("Composio");
    // The own servers are in Russia; no guessed country for the others.
    expect(result.serverLocation).toContain("Selectel в России");
    expect(result.serverLocation).toContain("не знает");
    expect(result.kept.join("\n")).not.toMatch(/Vercel|Neon/u);
    expect(result.google).toBe(googleAccessOptions("full"));
    const remove = result.remove.join("\n");
    expect(remove).toContain("«удали всё, что ты про меня помнишь»");
    expect(remove).toContain("«отключи Google»");
    expect(remove).toContain("В самом Google ничего не удаляется");
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

  // Review of item 28: a pilot workspace's messages sit in Postgres too.
  it("names the cross-channel log only for a pilot workspace", async () => {
    const outside = await withServices({});
    expect((await overview(outside.tool)).kept.join("\n")).not.toContain(
      "14 дней"
    );

    const pilot = await withServices({ CROSS_CHANNEL_WORKSPACES: "*" });
    const kept = (await overview(pilot.tool)).kept.join("\n");
    expect(kept).toContain("веб-чате, Telegram и iMessage");
    expect(kept).toContain("14 дней");
    expect(kept).toContain("«удали всё, что ты про меня помнишь» стирает их");
    // Review of item 28: the nightly backups keep them a while longer.
    expect(kept).toContain(
      "ещё до 14 дней остаются в ночных зашифрованных резервных копиях"
    );
  });

  it("names the signature sample and the signings' record only in the signing pilot", async () => {
    const signing = {
      BROWSER_STATE_BUCKET: "test-bucket",
      CLOUDRU_KEY_ID: "test-key-id",
      CLOUDRU_KEY_SECRET: "test-key-secret",
      CLOUDRU_S3_TENANT_ID: "test-tenant",
      OPENROUTER_API_KEY: "openrouter-test-key",
      SANDBOX_HOST_ID: "sbx-test",
      SANDBOX_HOST_ORIGIN: "https://sandbox.example.test",
      SANDBOX_SIGNING_KEY: "ab".repeat(32),
      SANDBOX_WORKSPACES: "*",
      TASK_FILES_WORKSPACES: "*",
    };
    const outside = await overview((await withServices(signing)).tool);
    expect(outside.kept.join("\n")).not.toContain("Образец подписи");

    const pilot = await overview(
      (
        await withServices({
          ...signing,
          AGENT_SANDBOX: "bro-cloudru",
          SIGN_WORKSPACES: "*",
        })
      ).tool
    );
    expect(pilot.kept.join("\n")).toContain(
      "в той же базе Postgres в зашифрованном виде"
    );
    expect(pilot.remove.join("\n")).toContain("«удали мою подпись»");
  });

  it("names the decision model only for the tool router's pilot", async () => {
    const outside = await withServices({
      MODEL_PROVIDER: "routerai",
      ROUTERAI_API_KEY: "routerai-test-key",
    });
    expect((await overview(outside.tool)).processors.join("\n")).not.toContain(
      "Jev"
    );

    vi.stubEnv("TOOL_ROUTER_WORKSPACES", scope.workspaceId);
    const pilot = await withServices({
      MODEL_PROVIDER: "routerai",
      ROUTERAI_API_KEY: "routerai-test-key",
    });
    const processors = (await overview(pilot.tool)).processors.join("\n");
    vi.stubEnv("TOOL_ROUTER_WORKSPACES", "");
    expect(processors).toContain("модель Jev компании TypeSafe");
    expect(processors).toContain("без кодов, номеров документов");

    // The kit router sends the task agent's job wherever its pilot reaches.
    const kit = await withServices({
      BROWSER_STATE_BUCKET: "test-bucket",
      CLOUDRU_KEY_ID: "test-key-id",
      CLOUDRU_KEY_SECRET: "test-key-secret",
      CLOUDRU_S3_TENANT_ID: "test-tenant",
      OPENROUTER_API_KEY: "openrouter-test-key",
      SANDBOX_HOST_ID: "sbx-test",
      SANDBOX_HOST_ORIGIN: "https://sandbox.example.test",
      SANDBOX_SIGNING_KEY: "ab".repeat(32),
      SANDBOX_WORKSPACES: "*",
      TASK_FILES_WORKSPACES: "*",
      TASK_KIT_ROUTER_WORKSPACES: scope.workspaceId,
    });
    expect((await overview(kit.tool)).processors.join("\n")).toContain(
      "модель Jev компании TypeSafe"
    );
  });

  // Geolocation: what is kept and for how long, what reaches OpenStreetMap,
  // and the honest note that the chat history keeps what was sent.
  it("names shared locations only for a workspace of the pilot", async () => {
    const outside = await overview((await withServices({})).tool);
    const outsideText = JSON.stringify(outside);
    expect(outsideText).not.toContain("Геопозиц");
    expect(outside.processors.join("\n")).toContain(
      "Адреса для расчёта дороги уходят в открытые сервисы OpenStreetMap."
    );
    const pilot = await overview(
      (await withServices({ LOCATION_WORKSPACES: "*" })).tool
    );
    expect(pilot.kept.join("\n")).toContain("до 90 дней");
    expect(pilot.kept.join("\n")).toContain("остаётся в истории чатов");
    expect(pilot.processors.join("\n")).toContain(
      "координаты присланных точек"
    );
    expect(pilot.remove.join("\n")).toContain("«забудь, где я был»");
    expect(pilot.kept.join("\n")).not.toContain("Пока вы транслируете");
    // Bro following a live share says so, and that it tells nobody else.
    const watching = await overview(
      (
        await withServices({
          LOCATION_WATCH_WORKSPACES: "*",
          LOCATION_WORKSPACES: "*",
        })
      ).tool
    );
    expect(watching.kept.join("\n")).toContain("никому другому");
  });

  // Bro ↔ Bro: what its own model call gets, and how long its threads stay.
  it("names what Bro ↔ Bro sends its model and keeps only where it is on", async () => {
    const routerAi = {
      MODEL_PROVIDER: "routerai",
      ROUTERAI_API_KEY: "routerai-test-key",
    };
    const outside = await overview((await withServices(routerAi)).tool);
    expect(JSON.stringify(outside)).not.toContain("Бро ↔ Бро");
    const pilot = await overview(
      (await withServices({ ...routerAi, BRO_TO_BRO_WORKSPACES: "*" })).tool
    );
    expect(pilot.processors.join("\n")).toContain(
      "через RouterAI: он получает ваше имя и часовой пояс"
    );
    expect(pilot.kept.join("\n")).toContain(
      "стираются через 30 дней после того, как переговоры закончились"
    );
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
    // Composio is configured in tests, so search goes to Instant first.
    expect(processors).toContain(
      "через Composio к поисковикам TinyFish и Tavily, а если те не ответили — через RouterAI к поисковикам Exa и Perplexity"
    );
    expect(processors).not.toContain("OpenRouter");
    expect(processors).not.toContain("Vercel AI Gateway");
  });

  it("names the memory digest's own model and what it never sends", async () => {
    const { facts } = await withServices({
      MODEL_PROVIDER: "routerai",
      ROUTERAI_API_KEY: "routerai-test-key",
    });
    const digest = facts
      .dataProcessors("deepseek/deepseek-v4.1-flash", { memoryDigest: true })
      .find((line) => line.startsWith("Раз в сутки сводка памяти"));

    expect(digest).toContain(
      "модели deepseek/deepseek-v4-flash через RouterAI"
    );
    expect(digest).toContain(
      "кроме правил, предпочтений и записей, помеченных как только локальные"
    );
  });

  it("names Selectel as the keeper of files once the bucket is configured", async () => {
    const { facts } = await withServices({
      BROWSER_STATE_BUCKET: "bucket-test",
      CLOUDRU_KEY_ID: "key-id",
      CLOUDRU_KEY_SECRET: "key-secret",
      CLOUDRU_S3_TENANT_ID: "tenant-id",
    });

    expect(
      facts.dataProcessors("deepseek/deepseek-v4.1-flash").join("\n")
    ).toContain("хранит Selectel в приватном хранилище Object Storage");
    expect(facts.keptData().join("\n")).toMatch(/Object Storage Selectel/u);
  });

  it("names the task agent's sandbox as a keeper of files once the person's files reach it", async () => {
    const storage = {
      BROWSER_STATE_BUCKET: "bucket-test",
      CLOUDRU_KEY_ID: "key-id",
      CLOUDRU_KEY_SECRET: "key-secret",
      CLOUDRU_S3_TENANT_ID: "tenant-id",
    };
    const host = {
      SANDBOX_HOST_ID: "sbx-test",
      SANDBOX_HOST_ORIGIN: "https://sandbox.example.test",
      SANDBOX_SIGNING_KEY: "ab".repeat(32),
    };
    const sentence = "копируются в его песочницу на сервере Selectel";
    const kept = async (services: Parameters<typeof withServices>[0]) =>
      (await withServices(services)).facts.keptData().join("\n");
    // Every gate of `taskFilesEnabled`: the files' list, the task agent's
    // pilot naming the same workspace, the direct model, the host, the bucket.
    const deployed = {
      ...storage,
      ...host,
      OPENROUTER_API_KEY: "openrouter-test-key",
      SANDBOX_WORKSPACES: "workspace-1",
      TASK_FILES_WORKSPACES: "workspace-1",
    };

    expect(await kept(deployed)).toContain(sentence);
    expect(await kept({ ...deployed, SANDBOX_WORKSPACES: "*" })).toContain(
      sentence
    );
    expect(
      await kept({
        ...deployed,
        SANDBOX_WORKSPACES: "workspace-2",
        TASK_FILES_WORKSPACES: "*",
      })
    ).toContain(sentence);
    expect(
      await kept({ ...deployed, TASK_FILES_WORKSPACES: "" })
    ).not.toContain(sentence);
    // No workspace is in both pilots: nobody's files reach the sandbox.
    expect(await kept({ ...deployed, SANDBOX_WORKSPACES: "" })).not.toContain(
      sentence
    );
    expect(
      await kept({ ...deployed, SANDBOX_WORKSPACES: "workspace-2" })
    ).not.toContain(sentence);
    expect(
      await kept({
        ...deployed,
        SANDBOX_WORKSPACES: "owner@example.test",
        TASK_FILES_WORKSPACES: "*",
      })
    ).not.toContain(sentence);
    // On the AI Gateway the task agent never runs.
    expect(await kept({ ...deployed, OPENROUTER_API_KEY: "" })).not.toContain(
      sentence
    );
    expect(
      await kept({
        ...deployed,
        BROWSER_STATE_BUCKET: "",
        CLOUDRU_KEY_ID: "",
        CLOUDRU_KEY_SECRET: "",
        CLOUDRU_S3_TENANT_ID: "",
      })
    ).not.toContain(sentence);
    expect(
      await kept({
        ...deployed,
        SANDBOX_HOST_ID: "",
        SANDBOX_HOST_ORIGIN: "",
        SANDBOX_SIGNING_KEY: "",
      })
    ).not.toContain(sentence);
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
    expect(processors).not.toContain("Object Storage");
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
    expect(facts.serverLocation()).toContain("Selectel в России");
    expect(facts.serverLocation()).toContain("остальных сервисов");
  });

  it("names the pool's own Selectel servers and the owner's transcripts, and DeepInfra behind RouterAI", async () => {
    const { facts } = await withServices({
      ...browserVmTestEnvironment,
      BROWSER_HOST_CLOUD: "static",
      BROWSER_HOST_STATIC: "host-1@203.0.113.7",
      BROWSER_VM_PROXY:
        "premium-residential.geonode.com:9000:geonode_bro-session-{session}:secret",
      MODEL_PROVIDER: "routerai",
      OWNER_TRANSCRIPTS: "on",
      ROUTERAI_API_KEY: "routerai-test-key",
    });
    const processors = facts
      .dataProcessors("deepseek/deepseek-v4.1-flash")
      .join("\n");

    expect(processors).toContain("выделенном сервере Selectel в России");
    expect(processors).not.toContain("Cloud.ru");
    expect(processors).toContain("хост DeepInfra");
    expect(facts.keptData().join("\n")).toContain(
      "Владелец сервиса может читать тексты переписки"
    );
  });

  it("names personal mail, Yandex services and the code sandbox once they are on", async () => {
    const { facts } = await withServices({
      MAIL_WORKSPACES: "*",
      SANDBOX_WORKSPACES: "*",
      YANDEX_API_WORKSPACES: "*",
    });
    const processors = facts
      .dataProcessors("deepseek/deepseek-v4.1-flash")
      .join("\n");

    expect(processors).toContain("Mail.ru или Яндекса");
    expect(processors).toContain("Еда, Лавка, Go, Маркет");
    expect(processors).toContain("песочнице на сервере Selectel");
    expect(processors).not.toContain("Яндекс Картах");
    // With geolocation, Maps search gets the person's latest point.
    expect(
      facts
        .dataProcessors("deepseek/deepseek-v4.1-flash", { location: true })
        .join("\n")
    ).toContain("поиск мест на Яндекс Картах");
  });

  it("names OpenAI's voice, and the brief only where the voice gets it", async () => {
    const { facts } = await withServices({});
    const model = "deepseek/deepseek-v4.1-flash";

    expect(facts.dataProcessors(model).join("\n")).not.toContain("GPT-Live");
    const calls = facts
      .dataProcessors(model, {
        voice: { brief: false, calls: true, talk: false },
      })
      .join("\n");
    expect(calls).toContain("Звонки Бро ведёт голосовая модель GPT-Live");
    expect(calls).not.toContain("сводку");
    const talk = facts
      .dataProcessors(model, {
        voice: { brief: true, calls: false, talk: true },
      })
      .join("\n");
    expect(talk).toContain("события календаря на неделю вперёд");
    expect(talk).not.toContain("Собеседнику звонка");
  });

  it("names the browser's second proxy too, when there is one", async () => {
    const { facts } = await withServices({
      ...browserVmTestEnvironment,
      BROWSER_VM_PROXY:
        "premium-residential.geonode.com:9000:geonode_bro-session-{session}:secret",
      BROWSER_VM_PROXY_FALLBACK:
        "gate.nodemaven.com:8080:bro-country-ru-sid-{session}-ttl-24h:secret",
    });

    expect(
      facts.dataProcessors("deepseek/deepseek-v4.1-flash").join("\n")
    ).toContain(
      "через резидентный прокси Geonode или NodeMaven: прокси видит, на какие сайты он заходит"
    );
  });

  it("says nothing of browser VMs a deployment without them does not have", async () => {
    const { facts } = await withServices({
      BROWSER_USE_API_KEY: "browser-use-test-key",
    });

    expect(
      facts.dataProcessors("deepseek/deepseek-v4.1-flash").join("\n")
    ).not.toContain("Cloud.ru");
    // Without the bucket nothing is stored, so no place of files is named.
    expect(facts.keptData().join("\n")).not.toContain("Object Storage");
    expect(facts.serverLocation()).not.toContain("Cloud.ru");
    expect(facts.serverLocation()).toContain(
      "регион нигде в его настройках не записан"
    );
  });
});

describe("offering read-only Google", () => {
  it.each([
    "никогда ничего не оплачивай и никому не пиши без моего ок",
    "письма отправляй только с моего разрешения",
    "never email anyone without asking me",
  ])("hears «%s» as a rule against sending", (rule) => {
    expect(restrictsSending(rule)).toBe(true);
  });

  it.each(["никогда ничего не оплачивай без моего ок", "не пиши мне ночью"])(
    "does not hear «%s» as one",
    (rule) => {
      expect(restrictsSending(rule)).toBe(false);
    }
  );

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

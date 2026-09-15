import {
  alreadyLoggedChatText,
  cookieCacheStale,
  cookieDomainsCoverPage,
  isBrowserProfileId,
  isLoginVaultTask,
  isLoginWaitTask,
  LOGIN_MARK,
  LOGIN_VAULT_MARK,
  loginChatText,
  loginOpeningText,
  loginPageFromTask,
  loginPageUrl,
  loginVaultChatText,
  loginVaultTask,
  loginWaitTask,
  LOGIN_REUSE_WINDOW_MS,
  nextLoginAction,
  normalizeBrowserProfileId,
  pickCookieDomains,
  profileSyncStatus,
} from "../convex/lib/browserProfilePolicy.ts";
import {
  hasNavigateActivity,
  liveUrlFromEvents,
  loginHostsMatch,
  loginLandingReady,
  pageUrlFromEvents,
  shouldSendLoginLink,
} from "../convex/lib/browserLivePolicy.ts";
import { asCdpTargets, browserFromList, cdpCurrentUrl } from "../convex/lib/browserCdp.ts";
import { errandStartUrl } from "../convex/lib/browserStartPolicy.ts";
import { scaffoldTask } from "../agent/lib/browseruse.ts";

import { assert, src } from "./lib/check.ts";

const id = "550e8400-e29b-41d4-a716-446655440000";
assert(isBrowserProfileId(id), "uuid ok");
assert(!isBrowserProfileId("bu_not_a_profile"), "api key is not a profile");
assert(normalizeBrowserProfileId(` ${id} `) === id, "trim id");

assert(loginPageUrl("https://www.ozon.ru/login")?.startsWith("https://"), "https ok");
assert(loginPageUrl("not a url") === undefined, "junk url");
assert(loginPageUrl("ftp://x") === undefined, "ftp rejected");

const wait = loginWaitTask("https://www.ozon.ru");
assert(wait.startsWith(LOGIN_MARK), "login mark");
assert(wait.includes("https://www.ozon.ru/"), "opens the page");
assert(wait.includes("Первым действием"), "navigate first");
assert(wait.includes("не about:blank"), "not blank preview");
assert(wait.includes("Не вводи логин"), "never types secrets");
assert(wait.includes("прислать в чат"), "login wait accepts a chat OTP");
assert(wait.includes("Пароль в iMessage не проси"), "login wait never asks for a password");
assert(wait.includes("«Войти»"), "live-view login may click Войти to open the form");
assert(!wait.includes("Не нажимай «войти» за него"), "must not forbid opening login");
assert(isLoginWaitTask(wait), "wait is a live-view login");
assert(scaffoldTask(wait) === wait, "login task not re-wrapped");
assert(
  loginPageFromTask(wait) === "https://www.ozon.ru/",
  "task keeps the login url",
);

const opening = loginOpeningText("Яндекс Такси");
assert(opening.includes("Открываю вход в Яндекс Такси"), "opening copy");
assert(!opening.includes("http"), "opening has no url");

const vaultTask = loginVaultTask("https://taxi.yandex.ru");
assert(vaultTask.startsWith(LOGIN_VAULT_MARK), "vault login mark");
assert(isLoginVaultTask(vaultTask), "vault task detected");
assert(!isLoginWaitTask(vaultTask), "vault task is not a live-view wait");
assert(scaffoldTask(vaultTask) === vaultTask, "vault task not re-wrapped");
assert(vaultTask.includes("Первым действием"), "vault login navigates first");
assert(vaultTask.includes("«Войти»"), "vault login clicks Войти if the form is closed");
assert(vaultTask.includes("site_login"), "vault task names login alias");
assert(vaultTask.includes("site_password"), "vault task names password alias");
assert(!vaultTask.includes("ochen"), "vault task has no secret");

const chat = loginChatText("https://live.example/view", "Ozon");
assert(chat.includes("Открой ссылку и войди в Ozon"), "plain chat copy");
assert(chat.includes("пароль не увидит"), "no password");
assert(/\n\nhttps:\/\/live\.example\/view$/.test(chat), "url on its own line");
assert(!chat.includes("profile.sh"), "no terminal helper");
assert(!chat.includes("Profile ID"), "no profile id");

const vaultChat = loginVaultChatText("Ozon");
assert(vaultChat.includes("войду в Ozon входом из сейфа"), "vault chat copy");
assert(!vaultChat.includes("http"), "vault chat has no url");
assert(!vaultChat.includes("пароль"), "vault chat does not say password");

assert(
  liveUrlFromEvents({
    events: [
      { type: "browser.ready", data: { live_view_url: "https://live.example/view" } },
    ],
  }) === "https://live.example/view",
  "events live_view_url",
);
assert(
  liveUrlFromEvents({
    events: [{ type: "browser.ready", data: { liveViewUrl: "https://live.example/camel" } }],
  }) === "https://live.example/camel",
  "events camelCase liveViewUrl",
);
assert(
  shouldSendLoginLink({
    loginWait: true,
    liveUrl: "https://live.example/view",
    landed: true,
  }),
  "send live link after landing",
);
assert(
  !shouldSendLoginLink({
    loginWait: true,
    liveUrl: "https://live.example/view",
  }),
  "do not send live link before the login page",
);
assert(
  !shouldSendLoginLink({
    loginWait: false,
    liveUrl: "https://live.example/view",
    landed: true,
  }),
  "do not send live link on vault login",
);

const readyOnly = {
  events: [
    { type: "run.created", data: { task: "Открой https://taxi.yandex.ru/" } },
    { type: "browser.ready", data: { live_view_url: "https://live.browser-use.com/view" } },
  ],
};
assert(
  liveUrlFromEvents(readyOnly) === "https://live.browser-use.com/view",
  "ready still exposes live_view_url",
);
assert(
  pageUrlFromEvents(readyOnly, "https://taxi.yandex.ru/") === undefined,
  "task echo on run.created is not a landing",
);
assert(
  !loginLandingReady({
    liveUrl: "https://live.browser-use.com/view",
    targetPage: "https://taxi.yandex.ru/",
    events: readyOnly,
  }),
  "blank preview is not the login page",
);

const navigated = {
  events: [
    { type: "browser.ready", data: { live_view_url: "https://live.browser-use.com/view" } },
    { type: "tool.navigate", data: { url: "https://taxi.yandex.ru/account" } },
  ],
};
assert(
  pageUrlFromEvents(navigated, "https://taxi.yandex.ru/") ===
    "https://taxi.yandex.ru/account",
  "navigate event is the login page",
);
assert(
  loginLandingReady({
    liveUrl: "https://live.browser-use.com/view",
    targetPage: "https://taxi.yandex.ru/",
    events: navigated,
  }),
  "ready after navigate is landable",
);
assert(
  loginHostsMatch("https://taxi.yandex.ru/", "https://passport.yandex.ru/auth"),
  "yandex passport is the login host",
);
assert(
  !loginHostsMatch("https://taxi.yandex.ru/", "https://yandex.ru/search"),
  "search is not the login page",
);
assert(
  hasNavigateActivity({
    events: [{ type: "tool.navigate", data: { name: "navigate" } }],
  }),
  "bare navigate counts as activity",
);
assert(
  !loginLandingReady({
    liveUrl: "https://live.browser-use.com/view",
    targetPage: "https://passport.yandex.ru/auth",
    events: [{ type: "tool.navigate", data: { name: "navigate" } }],
  }),
  "bare navigate is not the login page",
);
assert(
  loginLandingReady({
    liveUrl: "https://live.browser-use.com/view",
    targetPage: "https://passport.yandex.ru/auth",
    pageUrl: "https://passport.yandex.ru/auth?origin=taxi",
  }),
  "cdp tab url is the login page",
);
assert(
  !loginLandingReady({
    liveUrl: "https://live.browser-use.com/view",
    targetPage: "https://passport.yandex.ru/auth",
    pageUrl: "about:blank",
  }),
  "about:blank is not the login page",
);

assert(
  cookieDomainsCoverPage(
    ["passport.yandex.ru", "taxi.yandex.ru", "yandex.ru"],
    "https://passport.yandex.ru/auth",
  ),
  "yandex cookies cover passport",
);
assert(
  cookieDomainsCoverPage(["yandex.ru"], "https://taxi.yandex.ru/"),
  "parent yandex cookie covers taxi",
);
assert(
  !cookieDomainsCoverPage(["ozon.ru"], "https://passport.yandex.ru/auth"),
  "ozon cookies do not cover yandex",
);
assert(
  alreadyLoggedChatText("Яндекс Такси").includes("уже сохранён"),
  "already-logged copy",
);
assert(
  !alreadyLoggedChatText("Яндекс Такси").includes("http"),
  "already-logged has no url",
);

assert(profileSyncStatus({}) === "missing", "no profile");
assert(
  profileSyncStatus({ profileId: id, cookieDomains: ["ozon.ru"] }) === "synced",
  "cookies mean synced",
);
assert(
  pickCookieDomains(["ozon.ru", "ozon.ru", "wb.ru"]).join(",") === "ozon.ru,wb.ru",
  "dedupe domains",
);

const cabinet = src("cabinet.html");
assert(cabinet.includes('id="chrome"'), "cabinet has chrome card");
assert(cabinet.includes("пришлёт ссылку в чат"), "cabinet explains the chat link");
assert(cabinet.includes("вход из сейфа"), "cabinet mentions the vault login");
assert(cabinet.includes("/vault.html?kind=login"), "cabinet can add a login");
assert(!cabinet.includes("profile.sh"), "cabinet has no terminal helper");
assert(!cabinet.includes("profile-id"), "cabinet has no profile id field");
assert(!cabinet.includes("/me/browser-profile"), "cabinet does not paste ids");

const readme = src("README.md");
assert(readme.includes("texts a live-view link"), "readme is the chat-link flow");
assert(readme.includes("not sent while the preview is blank"), "readme waits for the login page");
assert(readme.includes("kind: login"), "readme mentions vault logins");
assert(!readme.includes("asks them for the password"), "readme never asks in chat");
assert(!readme.includes("profile.sh"), "readme has no terminal helper");

const tool = src("agent/tools/profile_setup.ts");
assert(tool.includes("deliverHuman"), "tool texts the link itself");
assert(tool.includes("loginChatText"), "tool uses the plain copy");
assert(tool.includes("vaultPasswordLogin"), "tool reads the vault first");
assert(tool.includes("loginVaultTask"), "tool starts a vault login run");
assert(tool.includes("cookieDomainsCoverPage"), "tool skips when cookies exist");
assert(tool.includes("alreadyLoggedChatText"), "tool says login is already saved");
assert(tool.includes("NO_PASSWORD_HINT") || tool.includes("Не проси"), "never ask for a password");

const vaultTool = src("agent/tools/vault_setup.ts");
assert(vaultTool.includes("kind=login") || vaultTool.includes("site login"), "vault_setup can mint a login page");

const follow = src("convex/browserFollow.ts");
assert(follow.includes("isLoginWaitTask"), "follow sends the live link only for wait tasks");
assert(follow.includes("shouldSendLoginLink"), "follow uses the live-link gate");
assert(follow.includes("landed"), "follow waits until the login page");

const startRun = src("agent/lib/browseruse.ts");
assert(startRun.includes("waitForPageLanding"), "cloud waits for the real page");
assert(startRun.includes("no startUrl"), "v4 has no start url");
assert(startRun.includes("cdpNavigate") || src("agent/lib/browser-cdp.ts").includes("Page.navigate"), "eve opens the site over cdp");
assert(tool.includes("waitForLoginLanding"), "tool waits for landing");
assert(
  errandStartUrl("вызови такси домой") === "https://taxi.yandex.ru/",
  "taxi wording opens taxi.yandex.ru",
);
assert(
  errandStartUrl("Открой https://taxi.yandex.ru. Закажи домой") ===
    "https://taxi.yandex.ru/",
  "explicit taxi url wins",
);
assert(
  src("agent/tools/browser_task.ts").includes("waitForPageLanding"),
  "browser_task opens the site over cdp",
);
assert(
  src("agent/instructions.md").includes("сразу `browser_task`"),
  "taxi goes to browser_task first",
);
assert(
  src("agent/instructions.md").includes("Cloud входит сам"),
  "eve tells the cloud job to log in",
);
assert(
  !src("agent/instructions.md").includes("не открывай Яндекс.паспорт"),
  "eve must not forbid passport",
);
assert(tool.includes("loginOpeningText"), "tool announces the login first");

assert(
  cdpCurrentUrl(
    asCdpTargets([{ type: "page", url: "about:blank", title: "" }]),
  ) === "about:blank",
  "cdp reads about:blank",
);
assert(
  browserFromList(
    {
      items: [
        {
          id: "b1",
          agentSessionId: "s1",
          liveUrl: "https://live.browser-use.com/view",
          cdpUrl: "https://b1.cdp.browser-use.com",
        },
      ],
    },
    "s1",
  )?.cdpUrl === "https://b1.cdp.browser-use.com",
  "browser list matches session",
);

// --- A3 F2: nextLoginAction — reuse an in-flight login for the same page ---

const now = Date.parse("2026-09-15T12:00:00.000Z");
const waitTask = loginWaitTask("https://www.ozon.ru");

assert(
  nextLoginAction({ page: "https://www.ozon.ru", now }) === "start",
  "no runId → start",
);
assert(
  nextLoginAction({
    runId: "run-1",
    status: "running",
    storedTask: "купи кроссовки",
    startedAt: now - 1000,
    page: "https://www.ozon.ru",
    now,
  }) === "start",
  "an active run that is not a login wait never blocks a fresh login",
);
assert(
  nextLoginAction({
    runId: "run-1",
    status: "running",
    storedTask: waitTask,
    startedAt: now - 1000,
    page: "https://www.wildberries.ru",
    now,
  }) === "start",
  "a login run for a different site does not block this one",
);
assert(
  nextLoginAction({
    runId: "run-1",
    status: "running",
    storedTask: waitTask,
    startedAt: now - 5 * 60_000,
    page: "https://www.ozon.ru",
    now,
  }) === "reuse",
  "same page, still active, within the reuse window → reuse",
);
assert(
  nextLoginAction({
    runId: "run-1",
    status: "running",
    storedTask: waitTask,
    startedAt: now - (LOGIN_REUSE_WINDOW_MS + 1),
    page: "https://www.ozon.ru",
    now,
  }) === "start",
  "past the reuse window → start fresh instead of polling forever",
);
assert(
  nextLoginAction({
    runId: "run-1",
    status: "completed",
    storedTask: waitTask,
    startedAt: now - 1000,
    page: "https://www.ozon.ru",
    now,
  }) === "start",
  "a terminal run is never reused",
);

// --- A3 F7: cookieCacheStale — a cached "cookies cover this page" verdict
// must not be trusted forever ---

assert(cookieCacheStale({}, now) === false, "never synced yet is not itself 'stale' (empty-domains check handles that)");
assert(
  cookieCacheStale({ browserProfileSyncedAt: now - 1000 }, now) === false,
  "freshly synced is not stale",
);
assert(
  cookieCacheStale({ browserProfileSyncedAt: now - 25 * 3600_000 }, now) === true,
  "older than 24h is stale",
);
assert(
  cookieCacheStale({ browserProfileSyncedAt: now - 1000, browserNeed: "password" }, now) === true,
  "a run that just reported needing a password invalidates the cache outright",
);

console.log("profile-sync-check ok");

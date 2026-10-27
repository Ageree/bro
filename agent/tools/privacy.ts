import { defineDynamic, defineTool } from "eve/tools";
import { z } from "zod";
import { crossChannelPilot } from "@agent/lib/conversation/pilot";
import { memoryDigestPilot } from "@agent/lib/memory/digest/pilot";
import { taskJobsDecided } from "@agent/lib/model/router/task";
import { taskKitRoutedWorkspace } from "@agent/lib/sandbox/pilot";
import { toolRouterListedWorkspace } from "@agent/lib/tool-router/pilot";
import { schedulesEnabled } from "@agent/lib/schedules/enabled";
import { resolveModeValue } from "@agent/lib/mode";
import { scopeFromPrincipal } from "@agent/lib/principal-scope";
import { signEnabled } from "@agent/lib/signatures/pilot";
import { partnerLinksPilot } from "@agent/lib/partner-links/travelpayouts";
import { yclientsPilot } from "@agent/lib/yclients/api";
import { agentMailboxEnabled } from "@db/services/agent-mail";
import { broToBroStanding } from "@db/services/bro-to-bro/enabled";
import { locationPilot, locationWatchPilot } from "@db/services/location";
import { phonePilot, readPhoneNumber } from "@db/services/phone";
import { liveCallsFor } from "@agent/lib/phone/live/place";
import { voiceFastEnabled, voiceTalkEnabled } from "@shared/voice/pilot";
import { env } from "@shared/environment";
import {
  dataProcessors,
  keptData,
  serverLocation,
} from "@agent/lib/privacy/facts";
import { googleAccessOptions } from "@agent/lib/privacy/google-access";
import {
  memoryRemoval,
  removalOutsideMemory,
} from "@agent/lib/privacy/removal";
import {
  getGoogleWorkspaceAccess,
  getWorkspaceModelId,
} from "@db/services/settings";
import {
  googleWorkspaceConfigured,
  googleWorkspaceRetainedData,
  readGoogleWorkspaceConnection,
} from "@shared/google-workspace/connection";
import type { AccessScope } from "@shared/identity/access-scope";
import { directModelActive } from "@shared/model/provider";

const googleUnknown = "Проверить подключение Google сейчас не получилось.";

/** Google as it stands for the person now, or nothing without Google here. */
async function googleNow(scope: AccessScope) {
  if (!googleWorkspaceConfigured()) return undefined;
  try {
    const access = await getGoogleWorkspaceAccess(scope);
    const connection = await readGoogleWorkspaceConnection(
      scope.userId,
      access
    );
    if (connection.state === "connected") return googleAccessOptions(access);
    if (connection.state === "disconnected") {
      return `Google не подключён: Бро не читает почту, календарь, контакты и Диск и ничего в них не меняет. В самом Google от отключения ничего не удалилось. ${googleWorkspaceRetainedData}`;
    }
  } catch (error) {
    console.warn("[privacy] could not read the Google connection", {
      message: error instanceof Error ? error.message : String(error),
    });
  }
  return googleUnknown;
}

const reply =
  "Default answer: 3-5 short sentences in plain everyday Russian, in one message, with no service, model, protocol or technology names (no Postgres, AES, Object Storage, model ids, proxies, captcha or messenger vendors) and no lists of everything. Say briefly: what you remember (for «что ты обо мне помнишь» read the memory and give 3-7 of the facts most useful to the person in plain words, never service labels), that the app, database and files are on servers in Russia and that some helpers are foreign companies (for example for calls and mail), without naming any country for them because you do not know it, and how to forget or delete, using the real ways from remove (e.g. «забудь …» or the memory page in the cabinet for memory, «останови все расписания» for schedules, and for the whole account write to the owner: it is deleted within 30 days). Never describe a browser, a helper or an agent as a separate performer: you do tasks on sites yourself. Use kept, processors, serverLocation, google and remove only when the person asks for details (which services, encryption, models, how to narrow Google); then name the services as given and add none of your own. Do not ask whether to delete or disconnect anything.";

export const privacy = defineTool({
  description:
    "What Bro keeps about the person and where, which outside services process it, and how the person deletes each part or narrows Bro's access. Call it whenever the person asks what you remember or keep about them, what is left of their data, where it is stored or who sees it (152-ФЗ included), how to delete it, or what you can access; answer from its result, briefly and in plain words unless they ask for details. It changes nothing.",
  inputSchema: z.object({}),
  async execute(_input, context) {
    const auth = context.session.auth.current;
    if (auth?.principalType !== "user") {
      throw new Error("An authenticated user is required.");
    }
    const scope = scopeFromPrincipal(auth);
    const phone =
      phonePilot(scope) ||
      (env.PHONE_AGENT_ID !== undefined &&
        (await readPhoneNumber(scope)) !== null);
    const signature = signEnabled(scope.workspaceId);
    const [modelId, google, memoryDigest, conversationLog, taskJobs, broToBro] =
      await Promise.all([
        getWorkspaceModelId(scope),
        googleNow(scope),
        // The digest's model reads memory only where the digest runs and asks.
        schedulesEnabled() && directModelActive()
          ? memoryDigestPilot(scope, { whenUnknown: true })
          : false,
        crossChannelPilot(scope),
        taskJobsDecided(scope),
        broToBroStanding(scope.workspaceId).then(
          (standing) => standing === "on",
          () => false
        ),
      ]);
    const location = locationPilot(scope);
    return {
      kept: keptData({
        broToBro,
        conversationLog,
        ...(location && { location }),
        ...(locationWatchPilot(scope) && { locationWatch: true }),
        phone,
        signature,
      }),
      processors: dataProcessors(modelId, {
        memoryDigest,
        agentMail: agentMailboxEnabled(scope),
        broToBro,
        decisionModel:
          (directModelActive() &&
            toolRouterListedWorkspace(scope.workspaceId)) ||
          taskKitRoutedWorkspace(scope.workspaceId) ||
          taskJobs,
        ...(location && { location }),
        ...(partnerLinksPilot(scope) && { partnerLinks: true }),
        phone,
        ...((voiceTalkEnabled(scope.workspaceId) ||
          (phone && liveCallsFor(scope.workspaceId))) && {
          voice: {
            brief: voiceFastEnabled(scope.workspaceId),
            calls: phone && liveCallsFor(scope.workspaceId),
            talk: voiceTalkEnabled(scope.workspaceId),
          },
        }),
        ...(yclientsPilot(scope) && { yclients: true }),
      }),
      serverLocation: serverLocation(),
      ...(google !== undefined && { google }),
      remove: [
        memoryRemoval(),
        ...removalOutsideMemory({ location, signature }),
        ...(phone
          ? [
              "phone-disable выключает звонки, но сохраняет номер и ежемесячную плату. Постоянное освобождение требует отдельного подтверждения phone-release; operator-required означает, что оператор должен проверить отключение и плата может продолжаться. Удаление памяти не освобождает платный номер.",
            ]
          : []),
      ],
      reply,
    };
  },
});

export default defineDynamic({
  events: {
    "turn.started": (_event, context) =>
      resolveModeValue(context, { interactive: { privacy } }),
  },
});

import { defineDynamic, defineTool } from "eve/tools";
import { z } from "zod";
import { resolveModeValue } from "@agent/lib/mode";
import { scopeFromPrincipal } from "@agent/lib/principal-scope";
import {
  dataProcessors,
  keptData,
  serverLocation,
} from "@agent/lib/privacy/facts";
import { googleAccessOptions } from "@agent/lib/privacy/google-access";
import { removalOutsideMemory } from "@agent/lib/privacy/removal";
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
  "Answer from these facts, briefly and in your own words, in one message: what is kept and where (kept), which outside services process it (processors), that you do not know the servers' countries (serverLocation), Google as it stands now with how to narrow or switch it off (google), and how the person deletes each part (remove). Name the services as given and add none of your own. Do not ask whether to delete or disconnect anything.";

export const privacy = defineTool({
  description:
    "What Bro keeps about the person and where, which outside services process it, and how the person deletes each part or narrows Bro's access. Call it whenever the person asks what you know or keep about them, what is left of their data, where it is stored or who sees it (152-ФЗ included), how to delete it, or what you can access; answer from its result. It changes nothing.",
  inputSchema: z.object({}),
  async execute(_input, context) {
    const auth = context.session.auth.current;
    if (auth?.principalType !== "user") {
      throw new Error("An authenticated user is required.");
    }
    const scope = scopeFromPrincipal(auth);
    const [modelId, google] = await Promise.all([
      getWorkspaceModelId(scope),
      googleNow(scope),
    ]);
    return {
      kept: keptData(),
      processors: dataProcessors(modelId),
      serverLocation,
      ...(google !== undefined && { google }),
      remove: [
        "Память и сохранённые дела — «удали всё, что ты про меня помнишь» или «забудь …»: стираются сразу.",
        ...removalOutsideMemory(),
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

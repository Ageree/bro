import { randomBytes } from "node:crypto";
import { open } from "node:fs/promises";
import { isDeepStrictEqual, parseArgs } from "node:util";
import { z } from "zod";
import type { env as phoneEnvironment } from "../../shared/environment/env.ts";
import { registerApplicationModuleResolution } from "../lib/module-resolution.ts";
import { endCallToolSchema } from "../../shared/phone/elevenlabs-tools.ts";
import { elevenlabsFetch } from "../../shared/phone/elevenlabs-http.ts";
import type { RequestInit } from "undici";

const id = z
  .string()
  .min(1)
  .max(200)
  .regex(/^[\w-]+$/u);
const jsonObject = z.record(z.string(), z.json());
const agentSchema = z.object({
  agent_id: id,
  conversation_config: jsonObject,
  platform_settings: jsonObject,
  workflow: jsonObject,
});
const hooksSchema = z.object({
  webhooks: z.array(
    z.object({
      name: z.string(),
      webhook_id: id,
      webhook_url: z.string(),
      auth_type: z.string(),
      is_disabled: z.boolean(),
      is_auto_disabled: z.boolean(),
    })
  ),
});
const globalLimitsSchema = z.object({
  agent_concurrency_limit: z.literal(-1),
  daily_limit: z.literal(100000),
  bursting_enabled: z.boolean(),
});
const endCall = {
  type: "system",
  name: "end_call",
  description: "",
  params: { system_tool_type: "end_call" },
};
const basePrompt =
  "Ты Бро, ИИ-помощник, не человек. Говори кратко и естественно по-русски. Оператор связи записывает разговор; честно сообщи об этом. Твой единственный инструмент end_call завершает этот разговор; инструментов для других действий и доступа к памяти, аккаунтам или личным сведениям пользователя нет. Не совершай покупки, бронирования, переводы и другие действия и не обещай их. Не запрашивай пароли, коды, платёжные или другие чувствительные сведения. Если цель звонка не передана, предложи собеседнику оставить короткое сообщение для пользователя. Когда сообщение принято, собеседник отказывается или хочет закончить, кратко попрощайся и сразу вызови end_call; не продолжай разговор.";
const firstMessage =
  "Здравствуйте! Я Бро, ИИ-помощник. Оператор связи записывает разговор. Вам удобно сейчас поговорить?";
let applying = false;
let env: typeof phoneEnvironment;

class SetupError extends Error {}

function object(value: z.core.util.JSONType | undefined) {
  const parsed = jsonObject.safeParse(value);
  if (!parsed.success)
    throw new SetupError("Provider settings have an unsupported shape.");
  return parsed.data;
}

async function request<T extends z.ZodType>(
  path: string,
  schema: T,
  method = "GET",
  body?: Record<string, z.core.util.JSONType | undefined>
): Promise<z.output<T>> {
  if (!env.ELEVENLABS_API_KEY)
    throw new SetupError("ELEVENLABS_API_KEY is required.");
  if (method !== "GET" && !applying)
    throw new SetupError("Provider writes require --apply.");
  try {
    const options: RequestInit = {
      method,
      headers: {
        "xi-api-key": env.ELEVENLABS_API_KEY,
        "Content-Type": "application/json",
      },
      cache: "no-store",
      redirect: "error",
      signal: AbortSignal.timeout(20_000),
    };
    if (body !== undefined) options.body = JSON.stringify(body);
    const response = await elevenlabsFetch(
      path,
      options,
      env.ELEVENLABS_PROXY_URL
    );
    if (!response.ok)
      throw new SetupError("Provider rejected operator request.");
    const parsed = schema.safeParse(await response.json());
    if (!parsed.success)
      throw new SetupError("Provider response is incompatible.");
    return parsed.data;
  } catch {
    throw new SetupError(
      method === "GET"
        ? "ElevenLabs settings read failed."
        : "ElevenLabs operator mutation is unverified; reconcile named resources before retrying."
    );
  }
}

async function findAgent(name: string) {
  const matches = new Set<string>();
  const cursors = new Set<string>();
  async function readPage(
    cursor: string | null,
    page: number
  ): Promise<string | null> {
    if (page >= 100)
      throw new SetupError("Agent inventory exceeds reconciliation limit.");
    const query = new URLSearchParams({ page_size: "100", search: name });
    if (cursor) query.set("cursor", cursor);
    const inventory = await request(
      `/v1/convai/agents?${query}`,
      z.object({
        agents: z.array(z.object({ agent_id: id, name: z.string() })),
        has_more: z.boolean(),
        next_cursor: z.string().nullish(),
      })
    );
    for (const agent of inventory.agents)
      if (agent.name === name) matches.add(agent.agent_id);
    if (matches.size > 1)
      throw new SetupError("The requested agent name is ambiguous.");
    if (!inventory.has_more) return matches.values().next().value ?? null;
    if (!inventory.next_cursor || cursors.has(inventory.next_cursor))
      throw new SetupError("Agent inventory is incomplete.");
    cursors.add(inventory.next_cursor);
    return readPage(inventory.next_cursor, page + 1);
  }
  return readPage(null, 0);
}

function configuration(
  agent: z.output<typeof agentSchema>,
  initiationUrl: string,
  initiationSecret: string,
  webhookId: string,
  globalLimits: z.output<typeof globalLimitsSchema>,
  maxDurationSeconds?: number
) {
  const config = agent.conversation_config;
  const platform = agent.platform_settings;
  const behavior = object(config.agent);
  const subagents = z.array(z.json()).safeParse(behavior.subagents);
  if (!subagents.success || subagents.data.length > 0)
    throw new SetupError(
      "Existing agent subagents require operator review; they will not be overwritten."
    );
  const prompt = object(behavior.prompt);
  const builtins = object(prompt.built_in_tools);
  const existingHangup = builtins.end_call ? object(builtins.end_call) : {};
  const hangup = { ...existingHangup, ...endCall };
  const auth = object(platform.auth);
  const allowlist = z
    .array(z.object({ hostname: z.string() }))
    .safeParse(auth.allowlist);
  if (!allowlist.success || allowlist.data.length > 0)
    throw new SetupError(
      "Existing agent origin allowlist conflicts with signed-URL auth; review it before setup."
    );
  const overrides = object(platform.overrides);
  const permissions = object(overrides.conversation_config_override);
  const agentPermissions = object(permissions.agent);
  const workspace = object(platform.workspace_overrides);
  const existingInitiation =
    workspace.conversation_initiation_client_data_webhook;
  if (existingInitiation && object(existingInitiation).url !== initiationUrl)
    throw new SetupError(
      "An unrelated agent initiation webhook is configured; it will not be replaced."
    );
  const hooks = object(workspace.webhooks);
  if (hooks.post_call_webhook_id && hooks.post_call_webhook_id !== webhookId)
    throw new SetupError(
      "An unrelated agent post-call webhook is configured; it will not be replaced."
    );
  const events = z.array(z.string()).safeParse(hooks.events);
  if (!events.success)
    throw new SetupError("Agent webhook event settings are incompatible.");
  const nodes = object(agent.workflow.nodes);
  if (
    Object.values(nodes).some(
      (node) => object(node).type !== "start" && object(node).type !== "end"
    ) ||
    Object.keys(object(agent.workflow.subgraphs ?? {})).length > 0
  )
    throw new SetupError(
      "Existing agent workflow actions require operator review; they will not be overwritten."
    );
  const headers = existingInitiation
    ? object(object(existingInitiation).request_headers)
    : {};
  const duration = z
    .number()
    .int()
    .min(1)
    .safeParse(object(config.conversation).max_duration_seconds);
  if (!duration.success)
    throw new SetupError("Agent base duration is incompatible.");
  return {
    conversation_config: {
      ...config,
      agent: {
        ...behavior,
        language: "ru",
        first_message: firstMessage,
        max_conversation_duration_message:
          "Разговор завершён. Спасибо! До свидания.",
        prompt: {
          ...prompt,
          prompt: basePrompt,
          tools: [],
          tool_ids: [],
          mcp_server_ids: [],
          native_mcp_server_ids: [],
          knowledge_base: [],
          built_in_tools: {
            ...Object.fromEntries(
              Object.keys(builtins).map((key) => [key, null])
            ),
            end_call: hangup,
          },
        },
      },
      conversation: {
        ...object(config.conversation),
        max_duration_seconds: maxDurationSeconds ?? duration.data,
      },
      tts: { ...object(config.tts), model_id: "eleven_v4_turbo" },
    },
    platform_settings: {
      ...platform,
      auth: { ...auth, enable_auth: true, allowlist: [] },
      privacy: {
        ...object(platform.privacy),
        record_voice: false,
        retention_days: 7,
        delete_audio: true,
        apply_to_existing_conversations: false,
      },
      call_limits: {
        ...object(platform.call_limits),
        ...globalLimits,
      },
      summary_language: "ru",
      overrides: {
        ...overrides,
        enable_conversation_initiation_client_data_from_webhook: true,
        conversation_config_override: {
          ...permissions,
          agent: {
            ...agentPermissions,
            first_message: true,
            prompt: { ...object(agentPermissions.prompt), prompt: true },
          },
          conversation: {
            ...object(permissions.conversation),
            max_duration_seconds: true,
          },
        },
      },
      workspace_overrides: {
        ...workspace,
        conversation_initiation_client_data_webhook: {
          url: initiationUrl,
          request_headers: {
            ...headers,
            "x-phone-init-secret": initiationSecret,
          },
        },
        webhooks: {
          ...hooks,
          post_call_webhook_id: webhookId,
          events: [
            ...new Set([
              ...events.data.filter(
                (event) =>
                  !event.includes("audio") && !event.includes("unredacted")
              ),
              "transcript",
              "call_initiation_failure",
            ]),
          ],
          transcript_format: "json",
          exclude_transcript: true,
        },
      },
    },
  };
}

function normalizedConversation(config: z.output<typeof jsonObject>) {
  const behavior = object(config.agent);
  const prompt = object(behavior.prompt);
  const tools = z.array(z.json()).safeParse(prompt.tools);
  const builtin = object(prompt.built_in_tools).end_call;
  if (
    !tools.success ||
    tools.data.length !== 1 ||
    !endCallToolSchema.safeParse(tools.data[0]).success ||
    !isDeepStrictEqual(tools.data[0], builtin)
  )
    return config;
  return {
    ...config,
    agent: { ...behavior, prompt: { ...prompt, tools: [] } },
  };
}

async function setup() {
  const { values } = parseArgs({
    options: {
      "public-url": { type: "string" },
      "create-agent": { type: "string" },
      "duration-seconds": { type: "string" },
      "enable-bursting": { type: "boolean", default: false },
      output: { type: "string" },
      apply: { type: "boolean", default: false },
      help: { type: "boolean", default: false },
    },
    strict: true,
    allowPositionals: false,
  });
  if (values.help) {
    console.log(
      "Phone setup defaults to read-only planning. --public-url https://your-domain --output /private/path/phone.env [--apply] [--create-agent exact-name] [--duration-seconds positive-integer] [--enable-bursting]. Provider-native limits are unlimited concurrency (-1) and the daily default 100000, not per-user call quotas. Existing provider duration is preserved unless explicitly changed; new agents default to the provider's 600 seconds. Use 60 only for a short test. Bursting defaults off; enabling it permits provider overflow charged at double rate. Load the existing private output as an env file on a repeated run. Never put secrets in arguments."
    );
    return;
  }
  registerApplicationModuleResolution();
  env = (await import("../../shared/environment/env.ts")).env;
  const capacity = globalLimitsSchema.safeParse({
    agent_concurrency_limit: -1,
    daily_limit: 100000,
    bursting_enabled: values["enable-bursting"],
  });
  if (!capacity.success)
    throw new SetupError("Global provider capacity options are invalid.");
  console.log(
    `Provider-native limits: concurrency ${String(capacity.data.agent_concurrency_limit)} (unlimited), daily default ${String(capacity.data.daily_limit)}, bursting ${String(capacity.data.bursting_enabled)}. No per-user call quotas are configured by this command.`
  );
  const duration = z.coerce
    .number()
    .int()
    .positive()
    .optional()
    .safeParse(values["duration-seconds"]);
  if (!duration.success)
    throw new SetupError("--duration-seconds must be a positive integer.");
  const publicUrl = z.url().safeParse(values["public-url"]);
  if (!publicUrl.success) throw new SetupError("--public-url is required.");
  const base = new URL(publicUrl.data);
  if (
    base.protocol !== "https:" ||
    base.username ||
    base.password ||
    base.search ||
    base.hash ||
    base.pathname !== "/"
  )
    throw new SetupError(
      "--public-url must be an HTTPS origin without credentials or a path."
    );
  if (values["create-agent"] && env.PHONE_AGENT_ID)
    throw new SetupError("Use PHONE_AGENT_ID or --create-agent, not both.");
  const name = z
    .string()
    .trim()
    .min(1)
    .max(100)
    .safeParse(values["create-agent"]);
  let agentId = env.PHONE_AGENT_ID;
  if (agentId) {
    const parsed = id.safeParse(agentId);
    if (!parsed.success) throw new SetupError("PHONE_AGENT_ID is invalid.");
  } else {
    if (!name.success)
      throw new SetupError(
        "Set PHONE_AGENT_ID; new agent creation requires --create-agent exact-name."
      );
    agentId = (await findAgent(name.data)) ?? undefined;
  }
  const initiationUrl = new URL("/api/phone/initiation", base).href;
  const postCallUrl = new URL("/api/phone/post-call", base).href;
  const hookName = agentId
    ? `Bro phone post-call ${agentId}`
    : `Bro phone post-call ${name.success ? name.data : ""}`;
  const inventory = await request("/v1/workspace/webhooks", hooksSchema);
  const matches = inventory.webhooks.filter((hook) => hook.name === hookName);
  if (matches.length > 1)
    throw new SetupError("Named post-call webhook is ambiguous.");
  const existingHook = matches[0];
  if (
    existingHook &&
    (existingHook.webhook_url !== postCallUrl ||
      existingHook.auth_type !== "hmac" ||
      existingHook.is_disabled ||
      existingHook.is_auto_disabled)
  )
    throw new SetupError(
      "Named post-call webhook is incompatible or disabled; review it before setup."
    );
  if (existingHook && !env.PHONE_WEBHOOK_SECRET)
    throw new SetupError(
      "Load PHONE_WEBHOOK_SECRET from the earlier private setup output; the provider does not expose it in webhook inventory."
    );
  const initiationSecret =
    env.PHONE_INIT_SECRET ?? randomBytes(32).toString("hex");
  const existingAgent = agentId
    ? await request(`/v1/convai/agents/${agentId}`, agentSchema)
    : null;
  if (existingAgent && existingAgent.agent_id !== agentId)
    throw new SetupError("Canonical agent binding is invalid.");
  if (existingAgent)
    configuration(
      existingAgent,
      initiationUrl,
      initiationSecret,
      existingHook?.webhook_id ?? "planned_hook",
      capacity.data,
      duration.data
    );
  if (!values.apply) {
    console.log(
      "Read-only plan validated. Applying will configure only the named Bro agent and its HMAC webhook, preserve workspace defaults, write private env output, and will not provision a number or place a call."
    );
    return;
  }
  if (!values.output)
    throw new SetupError(
      "--apply requires --output pointing to a new private env file."
    );
  const file = await open(values.output, "wx", 0o600);
  applying = true;
  let webhookSecret = env.PHONE_WEBHOOK_SECRET;
  async function save() {
    const entries = ["PHONE_INIT_SECRET=" + JSON.stringify(initiationSecret)];
    if (agentId) entries.push("PHONE_AGENT_ID=" + JSON.stringify(agentId));
    if (webhookSecret)
      entries.push("PHONE_WEBHOOK_SECRET=" + JSON.stringify(webhookSecret));
    const contents = entries.join("\n") + "\n";
    await file.write(contents, 0, "utf8");
    await file.truncate(Buffer.byteLength(contents));
    await file.sync();
  }
  try {
    await file.chmod(0o600);
    await save();
    if (!agentId) {
      if (!name.success)
        throw new SetupError("Explicit new agent name is required.");
      const created = await request(
        "/v1/convai/agents/create",
        z.object({ agent_id: id }),
        "POST",
        {
          name: name.data,
          conversation_config: {
            agent: {
              language: "ru",
              first_message: firstMessage,
              prompt: {
                prompt: basePrompt,
                llm: "gpt-6-luna",
                reasoning_effort: "none",
                enable_reasoning_summary: false,
                tools: [],
                tool_ids: [],
                mcp_server_ids: [],
                native_mcp_server_ids: [],
                knowledge_base: [],
                built_in_tools: { end_call: endCall },
              },
            },
            conversation: {
              max_duration_seconds: duration.data ?? 600,
            },
            tts: { model_id: "eleven_v4_turbo" },
          },
          platform_settings: {
            auth: { enable_auth: true, allowlist: [] },
            privacy: {
              record_voice: false,
              retention_days: 7,
              delete_audio: true,
            },
            call_limits: capacity.data,
          },
        }
      );
      agentId = created.agent_id;
      await save();
    }
    let webhookId = existingHook?.webhook_id;
    if (!webhookId) {
      const created = await request(
        "/v1/workspace/webhooks",
        z.object({ webhook_id: id, webhook_secret: z.string().min(32) }),
        "POST",
        {
          settings: {
            auth_type: "hmac",
            name: `Bro phone post-call ${agentId}`,
            webhook_url: postCallUrl,
          },
        }
      );
      webhookId = created.webhook_id;
      webhookSecret = created.webhook_secret;
      await save();
    }
    const current = await request(`/v1/convai/agents/${agentId}`, agentSchema);
    if (current.agent_id !== agentId)
      throw new SetupError("Canonical agent binding is invalid.");
    const planned = configuration(
      current,
      initiationUrl,
      initiationSecret,
      webhookId,
      capacity.data,
      duration.data
    );
    const changed =
      JSON.stringify(normalizedConversation(current.conversation_config)) !==
        JSON.stringify(planned.conversation_config) ||
      JSON.stringify(current.platform_settings) !==
        JSON.stringify(planned.platform_settings);
    if (changed)
      await request(
        `/v1/convai/agents/${agentId}`,
        agentSchema,
        "PATCH",
        planned
      );
    const verified = await request(`/v1/convai/agents/${agentId}`, agentSchema);
    const target = configuration(
      verified,
      initiationUrl,
      initiationSecret,
      webhookId,
      capacity.data,
      duration.data
    );
    if (
      JSON.stringify(normalizedConversation(verified.conversation_config)) !==
        JSON.stringify(target.conversation_config) ||
      JSON.stringify(verified.platform_settings) !==
        JSON.stringify(target.platform_settings)
    )
      throw new SetupError(
        "Agent setup was not verified by canonical readback."
      );
    const hooks = await request("/v1/workspace/webhooks", hooksSchema);
    const confirmed = hooks.webhooks.filter(
      (hook) => hook.webhook_id === webhookId
    );
    if (
      confirmed.length !== 1 ||
      confirmed[0]?.webhook_url !== postCallUrl ||
      confirmed[0].auth_type !== "hmac" ||
      confirmed[0].is_disabled ||
      confirmed[0].is_auto_disabled
    )
      throw new SetupError("Post-call HMAC webhook setup is not verified.");
    console.log(
      "Phone agent settings verified; generated secrets are only in the mode-0600 output file. Configure those env values and deploy the endpoints before enabling voice. Signed delivery and actual call audio still require separate authorized verification."
    );
  } finally {
    await file.close();
  }
}

try {
  await setup();
} catch (error) {
  console.error(
    error instanceof SetupError
      ? error.message
      : "Phone setup did not complete. Check CLI options, provider permissions and existing agent hooks; reconcile named resources read-only before any retry. Keep the private output file: it retains any IDs and signing secret already received."
  );
  process.exitCode = 1;
}

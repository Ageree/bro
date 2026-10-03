import { readdirSync, readFileSync } from "node:fs";
import type { DynamicResolveContext } from "eve/instructions";
import { vi } from "vitest";
import { z } from "zod";
import type executionSafety from "@agent/instructions/10-execution-safety";

/**
 * The system prompt of a kind of turn, as eve builds it from
 * `agent/instructions.md` and the resolvers of `agent/instructions/*.ts`.
 * A test that uses it mocks the database services the resolvers read
 * (spending, time zone, form of address, other chats).
 */

const directory = new URL("../../agent/instructions/", import.meta.url);

const resolverModuleSchema = z.object({
  default: z.object({
    events: z.object({
      "turn.started": z.custom<
        NonNullable<(typeof executionSafety)["events"]["turn.started"]>
      >((value) => z.function().safeParse(value).success),
    }),
  }),
});

/** A caller of a kind of turn, in a workspace. */
function contextOf(
  authenticator: string,
  attributes: Record<string, string> = {},
  initiator: Record<string, string> | null = null
) {
  const current = {
    attributes: { ...attributes, workspaceId: "workspace-1" },
    authenticator,
    principalId: "user-1",
    principalType: "user" as const,
  };
  return {
    channel: { kind: "channel:eve", metadata: {} },
    messages: [],
    model: null,
    session: {
      auth: {
        current,
        initiator: initiator
          ? { ...current, attributes: { ...current.attributes, ...initiator } }
          : null,
      },
      id: "session-1",
    },
  } satisfies DynamicResolveContext;
}

/** Every kind of turn whose instructions differ, or might. */
export const turnKinds = {
  "browser-result": contextOf("browser-result", { browserRunId: "run-1" }),
  interactive: contextOf("authjs"),
  "proactive-worker": contextOf(
    "scheduled-worker",
    {},
    { scheduledRunKind: "proactive" }
  ),
  "scheduled-report": contextOf("scheduled-result"),
  "scheduled-worker": contextOf("scheduled-worker"),
  telegram: contextOf("telegram-webhook"),
};

/** A deployment with the browser, drawing and the direct model set up. */
export const fullDeployment = {
  BROWSER_STATE_BUCKET: "test-bucket",
  BROWSER_USE_API_KEY: "test-browser-use-key",
  CLOUDRU_KEY_ID: "test-key-id",
  CLOUDRU_KEY_SECRET: "test-key-secret",
  CLOUDRU_S3_TENANT_ID: "test-tenant",
  OPENROUTER_API_KEY: "test-openrouter-key",
};

/** The task agent's sandbox host, with every workspace in its pilot. */
export const taskAgentDeployment = {
  SANDBOX_HOST_ID: "sbx-test",
  SANDBOX_HOST_ORIGIN: "https://sandbox.example.test",
  SANDBOX_SIGNING_KEY: "ab".repeat(32),
  SANDBOX_WORKSPACES: "*",
};

/**
 * Sets the deployment's variables and loads the modules afresh: the
 * environment is read once, when its module loads. `tests/setup-env.ts`
 * unsets every one of them, and the shell's own values must not come back.
 */
export function stubDeployment(environment: Record<string, string>) {
  for (const name of new Set([
    ...Object.keys(fullDeployment),
    ...Object.keys(taskAgentDeployment),
    "SKILLS_WORKSPACES",
    ...Object.keys(environment),
  ])) {
    vi.stubEnv(name, environment[name]);
  }
  vi.resetModules();
}

/** The system prompt eve builds: the static file, then each resolver. */
export async function systemPrompt(context: DynamicResolveContext) {
  const files = readdirSync(directory)
    .filter((file) => file.endsWith(".ts"))
    .toSorted();
  const parts = await Promise.all(
    files.map(async (file) => {
      const resolver = resolverModuleSchema.parse(
        await import(new URL(file, directory).href)
      );
      const resolved = await resolver.default.events["turn.started"](
        {},
        context
      );
      return resolved?.content ?? null;
    })
  );
  return [
    readFileSync(new URL("../instructions.md", directory), "utf8"),
    ...parts.filter((part) => part !== null),
  ].join("\n\n");
}

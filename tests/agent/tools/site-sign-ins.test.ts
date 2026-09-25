import type { DynamicResolveContext, ToolContext } from "eve/tools";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import type {
  forgetSignIns,
  listKeptSignIns,
} from "@agent/lib/browser-use/sign-ins";
import { accessScopeForUser } from "@shared/identity/access-scope";

const signIns = vi.hoisted(() => ({
  forget: vi.fn<typeof forgetSignIns>(),
  list: vi.fn<typeof listKeptSignIns>(),
}));
const configured = vi.hoisted(() => ({ value: true }));

vi.mock("@agent/lib/browser-use/sign-ins", () => ({
  forgetSignIns: signIns.forget,
  listKeptSignIns: signIns.list,
}));
vi.mock("@agent/lib/browser-use/client", () => ({
  browserUseConfigured: () => configured.value,
}));

import siteSignInTools, { siteSignIns } from "@agent/tools/site_sign_ins";

const scope = accessScopeForUser("better-auth:user-1");

beforeEach(() => {
  vi.clearAllMocks();
  configured.value = true;
});

/**
 * Review of wave 6: Bro kept the person's sign-ins and opened their account
 * pages on its own, and nothing told them so or let them stop it.
 */
describe("site_sign_ins", () => {
  it("is offered only in the person's own turn, and only with the cloud browser", async () => {
    const resolve = siteSignInTools.events["turn.started"];
    if (!resolve) throw new Error("Expected a turn resolver.");
    const tools = await resolve({}, dynamicContext("telegram-webhook"));
    expect(tools && !("execute" in tools) ? Object.keys(tools) : []).toEqual([
      "site_sign_ins",
    ]);
    // A browser report's text is the page's: it must not delete a profile.
    expect(await resolve({}, dynamicContext("browser-result"))).toBeNull();
    expect(await resolve({}, dynamicContext("scheduled-worker"))).toBeNull();
    configured.value = false;
    expect(await resolve({}, dynamicContext("telegram-webhook"))).toBeNull();
  });

  it("lists the sites on record and says how the visits stand", async () => {
    signIns.list.mockResolvedValue([
      {
        keptAlive: true,
        lastSeen: "2026-09-24",
        site: "ozon.ru",
        state: "signed_in",
      },
      {
        keptAlive: false,
        lastSeen: "2026-09-20",
        site: "wildberries.ru",
        state: "signed_in",
      },
    ]);

    const result = await run({ action: "list" });

    expect(signIns.list).toHaveBeenCalledExactlyOnceWith(scope.workspaceId);
    expect(result).toMatchObject({
      sites: [
        { keptAlive: true, site: "ozon.ru" },
        { keptAlive: false, site: "wildberries.ru" },
      ],
    });
    const { keepAlive } = z.object({ keepAlive: z.string() }).parse(result);
    expect(keepAlive).toContain("clicks nothing there");
    expect(keepAlive).toContain("keptAlive false is never opened on its own");
  });

  it("forgets every sign-in, or one site for good, or says plainly it could not", async () => {
    signIns.forget.mockResolvedValueOnce({ domains: ["ozon.ru"], kind: "all" });
    expect(answer(await run({ action: "forget" }))).toEqual([
      "forgotten",
      expect.stringContaining("and any follow-up of an earlier one"),
    ]);
    expect(signIns.forget.mock.calls[0]?.[0]).toMatchObject({
      workspaceId: scope.workspaceId,
    });

    signIns.forget.mockResolvedValueOnce({ kind: "site", site: "ozon.ru" });
    expect(answer(await run({ action: "forget", site: "ozon.ru" }))).toEqual([
      "forgotten",
      expect.stringContaining(
        "no longer opens ozon.ru on its own, now or after later errands there"
      ),
    ]);

    // The cloud kept the profile: nothing changed, and Bro says so.
    signIns.forget.mockResolvedValueOnce({ kind: "failed" });
    expect(answer(await run({ action: "forget" }))).toEqual([
      "not_forgotten",
      expect.stringContaining("Nothing was forgotten"),
    ]);

    signIns.forget.mockResolvedValueOnce({ kind: "busy" });
    expect(answer(await run({ action: "forget" }))).toEqual([
      "not_forgotten",
      expect.stringContaining("An errand is still using Bro's browser"),
    ]);
  });
});

/** What a forget call said, as its status and note. */
function answer(result: Awaited<ReturnType<typeof run>>) {
  const { note, status } = z
    .object({ note: z.string(), status: z.string() })
    .parse(result);
  return [status, note];
}

async function run(input: Parameters<typeof siteSignIns.execute>[0]) {
  const result = await siteSignIns.execute(input, toolContext());
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

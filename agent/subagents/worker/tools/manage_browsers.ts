import type {
  BrowserCreateResponse,
  BrowserRetrieveResponse,
  BrowserUpdateResponse,
} from "@onkernel/sdk/resources/browsers";
import { defineTool } from "eve/tools";
import { z } from "zod";
import {
  dropBrowserSession,
  listBrowserSessionIds,
  registerBrowserSession,
  startBrowserErrand,
} from "../../../lib/convex";
import {
  ensureProxyId,
  ensureTenantProfile,
  isStatus,
  kernel,
  kernelRegion,
} from "../lib/kernel";
import { requireOwnedBrowser, workerTenant } from "../lib/scope";

const browserTimeoutFloorSeconds = 15 * 60;

const inputSchema = z.object({
  action: z.enum(["create", "update", "list", "get", "delete"]),
  save_changes: z.boolean().optional(),
  session_id: z.string().optional(),
  start_url: z.url().optional(),
  timeout_seconds: z
    .number()
    .int()
    .min(browserTimeoutFloorSeconds)
    .max(259_200)
    .optional(),
  viewport_width: z.number().int().min(1).optional(),
  viewport_height: z.number().int().min(1).optional(),
  status: z.enum(["active", "deleted", "all"]).optional(),
  limit: z.number().int().min(1).max(100).optional(),
  offset: z.number().int().min(0).optional(),
});

export default defineTool({
  description:
    'Manage browser sessions backed by the tenant persistent profile. Create read-only browsers by default so tasks can run in parallel. Immediately before a login, replace that task browser with one created using save_changes: true, then delete it after authentication so the session is saved. Only one profile writer may be active. Use "list" or "get" to inspect sessions.',
  inputSchema,
  async execute(input, ctx) {
    const phone = workerTenant(ctx);
    const signal = ctx.abortSignal;

    switch (input.action) {
      case "create": {
        const quota = await startBrowserErrand({
          phoneE164: phone,
          workerSessionId: ctx.session.id,
        });
        if (!quota.allowed) {
          return {
            status: "limit",
            hint: "скажи человеку, что лимит браузер-задач на месяц исчерпан, предложи оплату",
          };
        }

        const profileId = await ensureTenantProfile(phone, signal);
        const proxyId = await ensureProxyId(signal);
        const region = kernelRegion();
        const saveChanges = input.save_changes ?? false;
        const browser = await kernel().browsers.create(
          {
            profile: {
              id: profileId,
              save_changes: saveChanges,
            },
            start_url: input.start_url,
            stealth: true,
            ...(proxyId ? { proxy: { id: proxyId } } : {}),
            ...(region ? { region } : {}),
            timeout_seconds:
              input.timeout_seconds ?? browserTimeoutFloorSeconds,
            viewport: browserViewport(input),
          },
          { signal },
        );

        let registered: Awaited<ReturnType<typeof registerBrowserSession>>;
        try {
          registered = await registerBrowserSession({
            phoneE164: phone,
            sessionId: browser.session_id,
            workerSessionId: ctx.session.id,
            saveChanges,
          });
        } catch (error) {
          await kernel()
            .browsers.deleteByID(browser.session_id, { signal })
            .catch(() => undefined);
          throw error;
        }
        if (!registered.ok) {
          await kernel()
            .browsers.deleteByID(browser.session_id, { signal })
            .catch(() => undefined);
          throw new Error(
            `Browser session ${registered.sessionId} is already saving login state for this tenant. Retry after it finishes.`,
          );
        }
        return lifecycleResult(browser);
      }
      case "list": {
        const sessionIds = await listBrowserSessionIds(phone);
        const includeDeleted = input.status !== "active";
        const browsers = await Promise.all(
          sessionIds.map(async (sessionId) => {
            try {
              const browser = await kernel().browsers.retrieve(
                sessionId,
                { include_deleted: includeDeleted },
                { signal },
              );
              const value = browserDescriptor(browser);
              if (input.status === "deleted" && value.status !== "deleted") {
                return null;
              }
              if (input.status === "active" && value.status !== "active") {
                return null;
              }
              return value;
            } catch (error) {
              if (isStatus(error, 404)) {
                await dropBrowserSession(phone, sessionId);
              }
              return null;
            }
          }),
        );
        const offset = input.offset ?? 0;
        const limit = input.limit ?? 100;
        return {
          has_more: false,
          items: browsers
            .filter((browser) => browser !== null)
            .slice(offset, offset + limit),
          next_offset: null,
        };
      }
      case "get": {
        const sessionId = requireSessionId(input.session_id);
        await requireOwnedBrowser(ctx, sessionId);
        return browserDescriptor(
          await retrieveBrowser(phone, sessionId, signal),
        );
      }
      case "update": {
        const sessionId = requireSessionId(input.session_id);
        await requireOwnedBrowser(ctx, sessionId);
        const viewport = browserViewport(input);
        const browser = viewport
          ? await kernel().browsers.update(sessionId, { viewport }, { signal })
          : await retrieveBrowser(phone, sessionId, signal);
        return lifecycleResult(browser);
      }
      case "delete": {
        const sessionId = requireSessionId(input.session_id);
        await requireOwnedBrowser(ctx, sessionId);
        await kernel()
          .browsers.deleteByID(sessionId, { signal })
          .catch((cause: unknown) => {
            if (!isStatus(cause, 404)) throw cause;
          });
        await dropBrowserSession(phone, sessionId);
        return "Browser session deleted successfully";
      }
    }
    throw new Error("Unsupported browser management action.");
  },
});

function requireSessionId(sessionId: string | undefined) {
  if (!sessionId) throw new Error("A browser session ID is required.");
  return sessionId;
}

async function retrieveBrowser(
  phone: string,
  sessionId: string,
  signal?: AbortSignal,
) {
  try {
    return await kernel().browsers.retrieve(sessionId, {}, { signal });
  } catch (error) {
    if (!isStatus(error, 404)) throw error;
    await dropBrowserSession(phone, sessionId);
    throw new Error(
      "Browser session no longer exists. Its stale record was removed; create a fresh browser instead of retrying this session ID.",
      { cause: error },
    );
  }
}

function browserViewport(input: z.infer<typeof inputSchema>) {
  const height = input.viewport_height;
  const width = input.viewport_width;
  if (height === undefined && width === undefined) return undefined;
  if (height === undefined || width === undefined) {
    throw new Error("Viewport width and height must be provided together.");
  }
  return { height, width };
}

type KernelBrowser =
  | BrowserCreateResponse
  | BrowserRetrieveResponse
  | BrowserUpdateResponse;

function browserDescriptor(browser: KernelBrowser) {
  return {
    browser_live_view_url: browser.browser_live_view_url,
    session_id: browser.session_id,
    status: browser.deleted_at ? "deleted" : "active",
    viewport: browser.viewport ?? undefined,
  };
}

function lifecycleResult(browser: KernelBrowser) {
  const value = browserDescriptor(browser);
  return {
    browser: value,
    next_actions: [
      `Use execute_playwright_code with session_id "${value.session_id}" for deterministic browser automation.`,
      `Use computer_action with session_id "${value.session_id}" for visual browser control.`,
      `Use manage_browsers with action "delete" and session_id "${value.session_id}" when finished.`,
    ],
  };
}

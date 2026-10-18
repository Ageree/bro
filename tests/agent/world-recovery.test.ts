import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import type { WorkerUtils } from "graphile-worker";
import { Pool } from "pg";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The world's start-up recovery of active runs (patch
 * `@workflow__world-postgres@5.0.0-beta.44.patch`): eve awaits
 * `world.start()` before it serves, and the stock start queued every parked
 * session due at once, so a person's turn after a restart waited behind them.
 */
const addJob = vi.fn<WorkerUtils["addJob"]>();
vi.mock("graphile-worker", () => ({
  Logger: vi.fn<() => void>(),
  makeWorkerUtils: async () => ({
    addJob,
    migrate: async () => undefined,
    release: async () => undefined,
  }),
  run: async () => {
    throw new Error("the runner is not started in this test");
  },
}));

const worldEntry = createRequire(import.meta.url).resolve(
  "@workflow/world-postgres"
);
const list = vi.fn<() => Promise<ReturnType<typeof activeRuns>>>();

beforeEach(() => {
  addJob.mockReset();
  list.mockReset();
  // A loopback port nothing listens on: the queue defers its runner and
  // still accepts jobs.
  vi.stubEnv("WORKFLOW_LOCAL_BASE_URL", "http://127.0.0.1:1");
  vi.doMock(join(dirname(worldEntry), "streamer.js"), () => ({
    createStreamer: () => ({ close: async () => undefined }),
  }));
  vi.doMock(join(dirname(worldEntry), "storage.js"), () => ({
    createEventsStorage: () => ({}),
    createHooksStorage: () => ({}),
    createRunsStorage: () => ({ list }),
    createStepsStorage: () => ({}),
  }));
});

afterEach(() => {
  vi.unstubAllEnvs();
});

async function startedWorld() {
  const { createWorld } = await import("@workflow/world-postgres");
  // The queue's start only asks the pool whether a pg-boss schema exists;
  // Graphile and the storage that read through it are mocked above.
  const pool = Object.assign(new Pool(), {
    query: async () => ({ rows: [{ exists: false }] }),
  });
  return createWorld({ pool, queueConcurrency: 1 });
}

function activeRuns(count: number) {
  return {
    cursor: null,
    data: Array.from({ length: count }, (_, index) => ({
      runId: `wrun_${String(index)}`,
      workflowName: "session",
    })),
    hasMore: false,
  };
}

describe("world start-up recovery", () => {
  it("serves before the active runs are listed", async () => {
    const listing = Promise.withResolvers<ReturnType<typeof activeRuns>>();
    list.mockReturnValue(listing.promise);
    const world = await startedWorld();
    await expect(world.start()).resolves.toBeUndefined();
    expect(list).toHaveBeenCalledOnce();
    listing.resolve(activeRuns(0));
    await world.close?.();
  });

  it("queues the active runs behind new work, a few per second", async () => {
    list.mockResolvedValue(activeRuns(7));
    const world = await startedWorld();
    const startedAt = Date.now();
    await world.start();
    await vi.waitFor(() => {
      expect(addJob).toHaveBeenCalledTimes(7);
    });
    await world.close?.();
    const options = addJob.mock.calls.map(([, , given]) => given ?? {});
    expect(options.every(({ priority }) => priority === 10)).toBe(true);
    const delays = options.map(({ runAt }) =>
      runAt === undefined ? 0 : Math.round((runAt.getTime() - startedAt) / 1000)
    );
    expect(delays).toEqual([0, 0, 0, 1, 1, 1, 2]);
  });
});

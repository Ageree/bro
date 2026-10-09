import type { EventEmitter } from "node:events";
import type { ClientConfig } from "pg";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { databaseAnswers } from "@db/services/health";

const pg = vi.hoisted(() => {
  const clients: EventEmitter[] = [];
  const configs: ClientConfig[] = [];
  return {
    clients,
    configs,
    connect: vi.fn<() => Promise<void>>(),
    // Not a spy: a spy handles the promises it returns, so an end() nobody
    // catches would not show.
    end: (): Promise<void> => Promise.resolve(),
    ended: 0,
    query: vi.fn<() => Promise<void>>(),
  };
});

vi.mock("pg", async () => {
  const { EventEmitter } = await import("node:events");
  class Client extends EventEmitter {
    constructor(config: ClientConfig) {
      super();
      pg.configs.push(config);
      pg.clients.push(this);
    }

    connect() {
      return pg.connect();
    }

    query() {
      return pg.query();
    }

    end() {
      pg.ended += 1;
      return pg.end();
    }
  }
  return { Client, default: { Client } };
});

function theClient() {
  expect(pg.clients).toHaveLength(1);
  const [client] = pg.clients;
  if (!client) {
    throw new Error("no client was made");
  }
  return client;
}

beforeEach(() => {
  pg.clients.length = 0;
  pg.configs.length = 0;
  pg.connect.mockReset().mockResolvedValue();
  pg.query.mockReset().mockResolvedValue();
  pg.end = () => Promise.resolve();
  pg.ended = 0;
});

describe("the database probe of the health check", () => {
  it("bounds connect and query by the deadline on its own client", async () => {
    await databaseAnswers(3_000);
    expect(pg.configs).toEqual([
      expect.objectContaining({
        connectionTimeoutMillis: 3_000,
        query_timeout: 3_000,
      }),
    ]);
    // A pooler in front of the server refuses startup parameters it does not
    // know, and the whole probe with them.
    expect(pg.configs[0]).not.toHaveProperty("statement_timeout");
    expect(pg.query).toHaveBeenCalledTimes(1);
    expect(pg.ended).toBe(1);
  });

  it("survives a socket error that comes after it answered", async () => {
    await databaseAnswers(3_000);
    const client = theClient();
    expect(() =>
      client.emit("error", new Error("Connection terminated unexpectedly"))
    ).not.toThrow();
  });

  it("does not wait for a client that never ends", async () => {
    pg.end = () => new Promise(() => undefined);
    await expect(databaseAnswers(3_000)).resolves.toBeUndefined();
  });

  it("fails when the database does not answer, and still ends the client", async () => {
    const unhandled = vi.fn<NodeJS.UnhandledRejectionListener>();
    process.on("unhandledRejection", unhandled);
    pg.connect.mockRejectedValue(new Error("timeout expired"));
    pg.end = () => Promise.reject(new Error("Client was never connected"));
    await expect(databaseAnswers(3_000)).rejects.toThrow("timeout expired");
    expect(pg.query).not.toHaveBeenCalled();
    expect(pg.ended).toBe(1);
    await new Promise((resolve) => setImmediate(resolve));
    process.off("unhandledRejection", unhandled);
    // end() failing after the probe is over is no crash of the app either.
    expect(unhandled).not.toHaveBeenCalled();
    const client = theClient();
    expect(() =>
      client.emit("error", new Error("read ECONNRESET"))
    ).not.toThrow();
  });
});

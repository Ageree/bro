import { createServer, type Server } from "node:http";
import { createServer as createTcpServer } from "node:net";
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  onTestFinished,
  vi,
} from "vitest";
import { z } from "zod";
import {
  clearBrowserVmSettings,
  importWithSettings,
} from "@tests/helpers/browser-vm";

// The project's VMs as the Compute API lists them: public → private. The
// "private" side is loopback so a real fetch can land on the test server.
const { listCloudRuPrivateAddresses } = vi.hoisted(() => ({
  listCloudRuPrivateAddresses: vi.fn<() => Promise<Map<string, string>>>(),
}));

vi.mock("@agent/lib/browser-vm/cloudru", () => ({
  listCloudRuPrivateAddresses,
}));

let server: Server;
let port: number;
const hosts: string[] = [];

beforeEach(async () => {
  hosts.length = 0;
  server = createServer((request, response) => {
    hosts.push(request.headers.host ?? "");
    // No keep-alive: every request is a new connection, so a new lookup.
    response.setHeader("connection", "close");
    response.end("ok");
  });
  // A debugger socket's upgrade: recorded, then refused.
  server.on("upgrade", (request, socket) => {
    hosts.push(`upgrade ${request.headers.host ?? ""}`);
    socket.end("HTTP/1.1 403 Forbidden\r\n\r\n");
  });
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });
  ({ port } = z.object({ port: z.number() }).parse(server.address()));
});

afterEach(async () => {
  clearBrowserVmSettings();
  listCloudRuPrivateAddresses.mockReset();
  vi.restoreAllMocks();
  vi.resetModules();
  await new Promise((resolve) => server.close(resolve));
});

async function loadRoute(routing: "off" | "on") {
  return importWithSettings(
    { CLOUDRU_PRIVATE_ROUTING: routing },
    async () => import("@agent/lib/browser-vm/private-route")
  );
}

describe("private routing between the project's VMs", () => {
  it("changes nothing while it is off, as on Vercel", async () => {
    const route = await loadRoute("off");
    const init = { method: "GET" };
    expect(route.withPrivateRoute(init)).toEqual({ method: "GET" });
    expect(route.privateRouteDispatcher()).toBeUndefined();
    await route.resolvePrivateRoute("https://203-0-113-7.sslip.io/v1/health");
    expect(listCloudRuPrivateAddresses).not.toHaveBeenCalled();
  });

  it("dials a VM's sslip.io name at its private address, keeping the name", async () => {
    // 203.0.113.7 is unroutable here: only the private address answers.
    listCloudRuPrivateAddresses.mockResolvedValue(
      new Map([["203.0.113.7", "127.0.0.1"]])
    );
    const route = await loadRoute("on");
    const url = `http://203-0-113-7.sslip.io:${String(port)}/v1/health`;
    const first = await fetch(url, route.withPrivateRoute({ method: "GET" }));
    expect(await first.text()).toBe("ok");
    const second = await fetch(url, route.withPrivateRoute({ method: "GET" }));
    expect(await second.text()).toBe("ok");
    // The Host header (and for HTTPS, SNI and the certificate) is the name.
    expect(hosts).toEqual([
      `203-0-113-7.sslip.io:${String(port)}`,
      `203-0-113-7.sslip.io:${String(port)}`,
    ]);
    // The listing is kept: one Compute API read for both calls.
    expect(listCloudRuPrivateAddresses).toHaveBeenCalledTimes(1);
  });

  it("keeps the sslip.io name in TLS while it dials the private address", async () => {
    // A bare TCP listener at the private address reads the ClientHello: the
    // SNI, which the certificate is checked against too, is the name.
    const hellos: Buffer[] = [];
    const tls = createTcpServer((socket) => {
      let hello = Buffer.alloc(0);
      socket.on("data", (chunk: Buffer) => {
        hello = Buffer.concat([hello, chunk]);
        if (hello.length >= 5 && hello.length >= 5 + hello.readUInt16BE(3)) {
          hellos.push(hello);
          socket.destroy();
        }
      });
    });
    await new Promise<void>((resolve) => {
      tls.listen(0, "127.0.0.1", resolve);
    });
    onTestFinished(() => {
      tls.close();
    });
    const tlsPort = z.object({ port: z.number() }).parse(tls.address()).port;
    listCloudRuPrivateAddresses.mockResolvedValue(
      new Map([["203.0.113.7", "127.0.0.1"]])
    );
    const route = await loadRoute("on");
    await expect(
      fetch(
        `https://203-0-113-7.sslip.io:${String(tlsPort)}/v1/health`,
        route.withPrivateRoute({})
      )
    ).rejects.toThrow("fetch failed");
    expect(hellos).toHaveLength(1);
    // A TLS handshake record that names the host.
    expect(hellos[0]?.[0]).toBe(0x16);
    expect(hellos[0]?.includes("203-0-113-7.sslip.io")).toBe(true);
  });

  it("lists again for a known address after half a minute, since a deleted VM's floating IP may be another's", async () => {
    // The address was a VM's whose private address answers no more.
    listCloudRuPrivateAddresses.mockResolvedValue(
      new Map([["203.0.113.7", "127.0.0.2"]])
    );
    const route = await loadRoute("on");
    const url = `http://203-0-113-7.sslip.io:${String(port)}/v1/health`;
    await expect(fetch(url, route.withPrivateRoute({}))).rejects.toThrow(
      "fetch failed"
    );
    // A new VM got it; within half a minute the map is trusted as it is.
    listCloudRuPrivateAddresses.mockResolvedValue(
      new Map([["203.0.113.7", "127.0.0.1"]])
    );
    const now = Date.now();
    const clock = vi.spyOn(Date, "now").mockReturnValue(now + 20_000);
    await expect(fetch(url, route.withPrivateRoute({}))).rejects.toThrow(
      "fetch failed"
    );
    expect(listCloudRuPrivateAddresses).toHaveBeenCalledTimes(1);
    clock.mockReturnValue(now + 31_000);
    expect(await (await fetch(url, route.withPrivateRoute({}))).text()).toBe(
      "ok"
    );
    expect(listCloudRuPrivateAddresses).toHaveBeenCalledTimes(2);
  });

  it("looks the address up ahead of a request, so its timeout is not spent on the listing", async () => {
    listCloudRuPrivateAddresses.mockImplementation(
      async () =>
        new Promise((resolve) => {
          setTimeout(() => {
            resolve(new Map([["203.0.113.7", "127.0.0.1"]]));
          }, 1_000);
        })
    );
    const route = await loadRoute("on");
    const url = `http://203-0-113-7.sslip.io:${String(port)}/v1/health`;
    await route.resolvePrivateRoute(url);
    const response = await fetch(
      url,
      route.withPrivateRoute({ signal: AbortSignal.timeout(800) })
    );
    expect(await response.text()).toBe("ok");
    expect(listCloudRuPrivateAddresses).toHaveBeenCalledTimes(1);
  });

  it("opens a debugger socket to a VM the same way", async () => {
    listCloudRuPrivateAddresses.mockResolvedValue(
      new Map([["203.0.113.7", "127.0.0.1"]])
    );
    const route = await loadRoute("on");
    const socket = route.openPrivateRouteWebSocket(
      `ws://203-0-113-7.sslip.io:${String(port)}/v1/cdp/token`
    );
    await new Promise((resolve) => {
      socket.addEventListener("error", resolve);
    });
    expect(hosts).toEqual([`upgrade 203-0-113-7.sslip.io:${String(port)}`]);
  });

  it("dials the public address of a VM the project does not list, and asks again only later", async () => {
    listCloudRuPrivateAddresses.mockResolvedValue(new Map());
    const route = await loadRoute("on");
    // Not a VM of the project: the address in the name, as DNS would give.
    const url = `http://127-0-0-1.sslip.io:${String(port)}/`;
    expect(await (await fetch(url, route.withPrivateRoute({}))).text()).toBe(
      "ok"
    );
    const now = Date.now();
    // The same name again within ten seconds: the listing is not read.
    const clock = vi.spyOn(Date, "now").mockReturnValue(now + 5_000);
    expect(await (await fetch(url, route.withPrivateRoute({}))).text()).toBe(
      "ok"
    );
    expect(listCloudRuPrivateAddresses).toHaveBeenCalledTimes(1);
    clock.mockReturnValue(now + 31_000);
    await fetch(url, route.withPrivateRoute({}));
    expect(listCloudRuPrivateAddresses).toHaveBeenCalledTimes(2);
  });

  it("lists again for a VM created after the last listing", async () => {
    listCloudRuPrivateAddresses.mockResolvedValue(new Map());
    const route = await loadRoute("on");
    await fetch(
      `http://127-0-0-1.sslip.io:${String(port)}/`,
      route.withPrivateRoute({})
    );
    // Bro creates a VM; its first call comes seconds later. Its public
    // address (unroutable here) would hang: it must be dialed privately.
    listCloudRuPrivateAddresses.mockResolvedValue(
      new Map([["203.0.113.9", "127.0.0.1"]])
    );
    vi.spyOn(Date, "now").mockReturnValue(Date.now() + 5_000);
    const response = await fetch(
      `http://203-0-113-9.sslip.io:${String(port)}/v1/health`,
      route.withPrivateRoute({})
    );
    expect(await response.text()).toBe("ok");
    expect(listCloudRuPrivateAddresses).toHaveBeenCalledTimes(2);
  });

  it("falls back to the public address when the Compute API fails, and holds off the next listing", async () => {
    listCloudRuPrivateAddresses.mockRejectedValue(new Error("IAM is down"));
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const route = await loadRoute("on");
    const response = await fetch(
      `http://127-0-0-1.sslip.io:${String(port)}/`,
      route.withPrivateRoute({})
    );
    expect(await response.text()).toBe("ok");
    expect(warn).toHaveBeenCalledWith(
      "[private-route] could not list the project's VMs",
      { error: "IAM is down" }
    );
    const now = Date.now();
    // Another name within half a minute: no new listing, the public address
    // (127.0.0.2, where nothing listens).
    const clock = vi.spyOn(Date, "now").mockReturnValue(now + 10_000);
    await expect(
      fetch(
        `http://127-0-0-2.sslip.io:${String(port)}/`,
        route.withPrivateRoute({})
      )
    ).rejects.toThrow("fetch failed");
    expect(listCloudRuPrivateAddresses).toHaveBeenCalledTimes(1);
    clock.mockReturnValue(now + 31_000);
    await fetch(
      `http://127-0-0-1.sslip.io:${String(port)}/`,
      route.withPrivateRoute({})
    );
    expect(listCloudRuPrivateAddresses).toHaveBeenCalledTimes(2);
  });

  it("leaves every other name to DNS", async () => {
    const route = await loadRoute("on");
    const response = await fetch(
      `http://localhost:${String(port)}/`,
      route.withPrivateRoute({})
    ).catch(async () =>
      // localhost may resolve to ::1 first where the server is IPv4 only.
      fetch(`http://127.0.0.1:${String(port)}/`, route.withPrivateRoute({}))
    );
    expect(await response.text()).toBe("ok");
    expect(listCloudRuPrivateAddresses).not.toHaveBeenCalled();
  });
});

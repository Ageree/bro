import {
  BoxHttpError,
  createBoxClient,
  type BoxClient,
  type BoxState,
  type BoxType,
} from "../../agent/lib/boxClient.ts";

export type FakeBoxOpts = {
  now?: () => number;
};

export type FakeBox = BoxClient & {
  startsToday: () => number;
};

type InternalBox = {
  id: string;
  name?: string;
  state: BoxState;
  type?: BoxType;
  url?: string;
  archiveAfter?: number | null;
};

const READY: ReadonlySet<BoxState> = new Set(["ready", "idle", "running"]);

export function createFakeBox(opts: FakeBoxOpts = {}): FakeBox {
  const world = new FakeBoxWorld(opts.now ?? Date.now);
  const client = createBoxClient({
    apiKey: "fake",
    fetch: (input, init) => world.fetch(input, init),
  });
  return {
    ...client,
    startsToday: () => world.startsToday,
  };
}

class FakeBoxWorld {
  startsToday = 0;
  private readonly boxes = new Map<string, InternalBox>();
  private readonly files = new Map<string, Map<string, string>>();
  private readonly idempotentCreates = new Map<string, string>();
  private seq = 0;

  private readonly clock: () => number;

  constructor(clock: () => number) {
    this.clock = clock;
  }

  fetch = (
    input: Parameters<typeof fetch>[0],
    init?: Parameters<typeof fetch>[1],
  ): Promise<Response> => this.handle(input, init);

  private async handle(
    input: Parameters<typeof fetch>[0],
    init?: Parameters<typeof fetch>[1],
  ): Promise<Response> {
    try {
      return this.route(hrefOf(input), init);
    } catch (err) {
      if (err instanceof BoxHttpError) {
        return jsonRes(err.status, {
          ok: false,
          type: "box.error",
          status: err.status,
          code: err.code,
          message: err.message,
          error: {
            code: err.code,
            message: err.message,
            status: err.status,
          },
        });
      }
      throw err;
    }
  }

  private route(href: string, init?: RequestInit): Response {
    const url = new URL(href);
    const method = (init?.method ?? "GET").toUpperCase();
    const path = stripApiPrefix(url.pathname);
    const body = readJsonBody(init);

    if (method === "GET" && path === "/limits") {
      return jsonRes(200, {
        ok: true,
        type: "limits.info",
        canStart: true,
        activeBoxes: 0,
        unusedVendorField: { nested: true },
        starts: {
          unlimited: false,
          day: {
            limit: 150,
            used: this.startsToday,
            remaining: Math.max(0, 150 - this.startsToday),
            extra: "ok",
          },
          hour: { limit: 50, remaining: 40 },
        },
      });
    }

    if (method === "POST" && path === "/boxes") {
      return jsonRes(202, {
        ok: true,
        type: "box.created",
        box: this.toApi(
          this.createBox(asRecord(body), headerValue(init, "Idempotency-Key")),
        ),
      });
    }

    const parts =
      /^\/boxes\/([^/]+)(?:\/(stop|resume|commands|files|fork))?$/.exec(path);
    if (!parts) {
      throw new BoxHttpError(404, "not_found", "not found");
    }
    const boxId = parts[1]!;
    const action = parts[2];

    if (method === "GET" && action === undefined) {
      return jsonRes(200, {
        ok: true,
        type: "box.info",
        box: this.toApi(this.getBox(boxId, true)),
      });
    }

    if (method === "PATCH" && action === undefined) {
      return jsonRes(200, {
        ok: true,
        type: "box.info",
        box: this.toApi(this.patchBox(boxId, asRecord(body))),
      });
    }

    if (method === "DELETE" && action === undefined) {
      this.boxes.delete(boxId);
      this.files.delete(boxId);
      return jsonRes(200, { ok: true, type: "box.deleted", id: boxId });
    }

    if (method === "POST" && action === "stop") {
      return jsonRes(202, {
        ok: true,
        type: "box.stopping",
        id: boxId,
        status: "archiving",
        box: this.toApi(this.stopBox(boxId)),
      });
    }

    if (method === "POST" && action === "fork") {
      this.getBox(boxId, false);
      return jsonRes(202, {
        ok: true,
        type: "box.created",
        box: this.toApi(
          this.createBox(asRecord(body), headerValue(init, "Idempotency-Key")),
        ),
      });
    }

    if (method === "POST" && action === "resume") {
      return jsonRes(202, {
        ok: true,
        type: "box.resuming",
        id: boxId,
        status: "ready",
        box: this.toApi(this.resumeBox(boxId, asRecord(body))),
      });
    }

    if (method === "POST" && action === "commands") {
      return jsonRes(200, this.runCommand(boxId, asRecord(body)));
    }

    if (method === "GET" && action === "files") {
      const filePath = url.searchParams.get("path") ?? "";
      const encoding =
        url.searchParams.get("encoding") === "base64" ? "base64" : "utf8";
      const content = this.fileMap(boxId).get(filePath) ?? "";
      return jsonRes(200, {
        ok: true,
        type: "file.read",
        success: true,
        path: filePath,
        encoding,
        size: content.length,
        content,
      });
    }

    if (method === "PUT" && action === "files") {
      const rec = asRecord(body);
      const filePath = typeof rec.path === "string" ? rec.path : "";
      const content = typeof rec.content === "string" ? rec.content : "";
      this.fileMap(boxId).set(filePath, content);
      return jsonRes(200, {
        ok: true,
        type: "file.written",
        success: true,
        path: filePath,
        encoding: "utf8",
        size: content.length,
      });
    }

    throw new BoxHttpError(404, "not_found", "not found");
  }

  private createBox(
    body: Record<string, unknown>,
    idempotencyKey?: string,
  ): InternalBox {
    const key = idempotencyKey?.trim();
    if (key) {
      const existingId = this.idempotentCreates.get(key);
      if (existingId) {
        const existing = this.boxes.get(existingId);
        if (existing) return existing;
      }
    }
    this.startsToday += 1;
    this.seq += 1;
    const ttl =
      typeof body.ttlSeconds === "number" ? body.ttlSeconds : 3600;
    const type = isBoxType(body.type) ? body.type : undefined;
    const box: InternalBox = {
      id: `bx_test${String(this.seq).padStart(4, "0")}`,
      state: "provisioning",
      type,
      archiveAfter: this.clock() + ttl * 1000,
    };
    this.boxes.set(box.id, box);
    this.fileMap(box.id);
    if (key) this.idempotentCreates.set(key, box.id);
    return box;
  }

  private getBox(boxId: string, advance: boolean): InternalBox {
    const box = this.boxes.get(boxId);
    if (!box) throw new BoxHttpError(404, "not_found", "Box not found");
    if (advance) {
      if (box.state === "provisioning") {
        box.state = "ready";
        box.url = "https://machine.on.ascii.dev";
      } else if (box.state === "archiving") {
        box.state = "archived";
        box.url = undefined;
      }
    }
    return box;
  }

  private patchBox(
    boxId: string,
    body: Record<string, unknown>,
  ): InternalBox {
    const box = this.getBox(boxId, false);
    if (typeof body.name === "string") box.name = body.name;
    if (typeof body.ttlSeconds === "number") {
      box.archiveAfter = this.clock() + body.ttlSeconds * 1000;
    }
    if (body.ttlSeconds === null) box.archiveAfter = null;
    return box;
  }

  private stopBox(boxId: string): InternalBox {
    const box = this.getBox(boxId, false);
    box.state = "archiving";
    box.url = undefined;
    return box;
  }

  private resumeBox(
    boxId: string,
    body: Record<string, unknown>,
  ): InternalBox {
    const box = this.getBox(boxId, false);
    this.startsToday += 1;
    box.state = "ready";
    box.url = "https://machine.on.ascii.dev";
    if (isBoxType(body.type)) box.type = body.type;
    if (typeof body.ttlSeconds === "number") {
      box.archiveAfter = this.clock() + body.ttlSeconds * 1000;
    }
    return box;
  }

  private runCommand(
    boxId: string,
    body: Record<string, unknown>,
  ): Record<string, unknown> {
    const box = this.getBox(boxId, false);
    if (!READY.has(box.state)) {
      throw new BoxHttpError(409, "box_starting", "Box is still starting");
    }
    const command = typeof body.command === "string" ? body.command : "";
    if (command.includes("bro-desktop-capture screenshot")) {
      const path = "/home/user/screens/shot.png";
      this.fileMap(boxId).set(
        path,
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
      );
      return {
        ok: true,
        type: "command.finished",
        success: true,
        exitCode: 0,
        stdout: `${path}\n`,
        stderr: "",
        timedOut: false,
      };
    }
    if (command.includes("bro-desktop-capture record")) {
      const path = "/home/user/recordings/clip.mp4";
      this.fileMap(boxId).set(path, "AAAA");
      return {
        ok: true,
        type: "command.finished",
        success: true,
        exitCode: 0,
        stdout: `${path}\n`,
        stderr: "",
        timedOut: false,
      };
    }
    const cat = /^cat\s+(\S+)$/.exec(command.trim());
    const stdout = cat ? (this.fileMap(boxId).get(cat[1]!) ?? "") : "";
    return {
      ok: true,
      type: "command.finished",
      success: true,
      exitCode: 0,
      stdout,
      stderr: "",
      timedOut: false,
    };
  }

  private fileMap(boxId: string): Map<string, string> {
    let files = this.files.get(boxId);
    if (!files) {
      files = new Map();
      this.files.set(boxId, files);
    }
    return files;
  }

  private toApi(box: InternalBox): Record<string, unknown> {
    return {
      id: box.id,
      name: box.name ?? "Box",
      state: box.state,
      type: box.type,
      url: box.url ?? null,
      archiveAfter:
        box.archiveAfter === undefined
          ? undefined
          : box.archiveAfter === null
            ? null
            : new Date(box.archiveAfter).toISOString(),
      desktopAvailable: READY.has(box.state),
      snapshotAvailable: box.state === "archived",
      unusedVendorField: "ok",
    };
  }
}

function jsonRes(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function hrefOf(input: Parameters<typeof fetch>[0]): string {
  if (typeof input === "string") return input;
  if (input instanceof URL) return input.href;
  return input.url;
}

function stripApiPrefix(pathname: string): string {
  const prefix = "/api/box/v1";
  return pathname.startsWith(prefix) ? pathname.slice(prefix.length) : pathname;
}

function readJsonBody(init?: RequestInit): unknown {
  if (!init?.body) return undefined;
  if (typeof init.body !== "string") return undefined;
  if (init.body.length === 0) return undefined;
  try {
    return JSON.parse(init.body) as unknown;
  } catch {
    throw new BoxHttpError(400, "invalid_json", "Request body must be valid JSON");
  }
}

function asRecord(value: unknown): Record<string, unknown> {
  if (typeof value === "object" && value !== null && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  return {};
}

function isBoxType(value: unknown): value is BoxType {
  return value === "small" || value === "default" || value === "large";
}

function headerValue(init: RequestInit | undefined, name: string): string | undefined {
  const headers = init?.headers;
  if (!headers) return undefined;
  if (headers instanceof Headers) return headers.get(name) ?? undefined;
  if (Array.isArray(headers)) {
    const hit = headers.find(([k]) => k.toLowerCase() === name.toLowerCase());
    return hit?.[1];
  }
  const rec = headers as Record<string, string>;
  return rec[name] ?? rec[name.toLowerCase()];
}


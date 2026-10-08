import { createHash } from "node:crypto";
import type { ModelMessage } from "ai";
import type { DynamicResolveContext, ToolContext } from "eve/tools";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type * as browserFiles from "@agent/lib/browser-use/files";
import type * as browserVmRuns from "@agent/lib/browser-vm/runs";
import type * as ruleApproval from "@agent/lib/memory/rule-approval";
import type * as sandboxFiles from "@agent/lib/sandbox/files";
import type * as sandboxInbox from "@agent/lib/sandbox/inbox";
import type * as browserTaskModule from "@agent/tools/browser_task";
import type * as browserRuns from "@db/services/browser-runs";
import { catalogContext } from "@tests/helpers/tool-catalog";
import { toolContext } from "@tests/helpers/tool-context";

const transfer = vi.hoisted(() => ({
  continueErrand: vi.fn<typeof browserTaskModule.browserTask.execute>(),
  readOriginal: vi.fn<typeof sandboxInbox.readSandboxFileWithin>(),
  readRun:
    vi.fn<
      (
        ...args: Parameters<typeof browserRuns.readBrowserRunForScope>
      ) => Promise<ReturnType<typeof run> | undefined>
    >(),
  readShared: vi.fn<typeof sandboxFiles.readOwnedSharedFile>(),
  recordStep: vi.fn<typeof browserFiles.recordBrowserFileStep>(),
  rule: vi.fn<typeof ruleApproval.outboundRuleApproval>(),
  upload: vi.fn<typeof browserVmRuns.uploadBrowserVmSessionFile>(),
}));

vi.mock("@agent/lib/browser-vm/runs", () => ({
  uploadBrowserVmSessionFile: transfer.upload,
}));
vi.mock("@agent/lib/memory/rule-approval", () => ({
  outboundRuleApproval: transfer.rule,
}));
vi.mock("@agent/lib/model/direct", () => ({
  directModelSelection: () => {
    throw new Error("Empty saved rules need no model selection");
  },
}));
vi.mock("@shared/model/provider", () => ({
  directModelActive: () => false,
}));
vi.mock("@agent/lib/sandbox/files", async (importOriginal) => ({
  ...(await importOriginal<typeof sandboxFiles>()),
  readOwnedSharedFile: transfer.readShared,
}));
vi.mock("@agent/lib/sandbox/inbox", async (importOriginal) => ({
  ...(await importOriginal<typeof sandboxInbox>()),
  readSandboxFileWithin: transfer.readOriginal,
}));
vi.mock("@agent/tools/browser_task", () => ({
  browserTask: { execute: transfer.continueErrand },
}));
vi.mock("@db/services/browser-runs", () => ({
  readBrowserRunForScope: transfer.readRun,
}));
vi.mock("@db/services/memory/records", () => ({
  listCurrentRules: async () => [],
}));
vi.mock("@db/services/settings", () => ({
  getWorkspaceModelId: async () => "unused-model",
}));

const configured = vi.hoisted(() => ({ value: true }));
vi.mock("@agent/lib/browser-use/client", () => ({
  browserUseConfigured: () => configured.value,
}));

beforeEach(() => {
  configured.value = true;
  vi.stubEnv("SANDBOX_SIGNING_KEY", "33".repeat(32));
  vi.resetAllMocks();
  transfer.continueErrand.mockResolvedValue({
    note: "Attached",
    runId: "attachment-run",
    status: "running",
  });
  transfer.readOriginal.mockResolvedValue(uploadBytes);
  transfer.readRun.mockResolvedValue(run());
  transfer.rule.mockResolvedValue("not-applicable");
  transfer.upload.mockResolvedValue({
    path: "/workspace/uploads/passport.pdf",
    size: uploadBytes.byteLength,
  });
});
afterEach(() => {
  vi.stubEnv("BROWSER_VM_FILES_WORKSPACES", "");
  vi.stubEnv("SANDBOX_SIGNING_KEY", "");
  vi.resetModules();
});

const path = "/workspace/attachments/0123456789abcdef/passport.pdf";
const uploadBytes = new TextEncoder().encode("Synthetic passport PDF");
const uploadPath = `/workspace/attachments/${createHash("sha256").update(uploadBytes).digest("hex").slice(0, 16)}/passport.pdf`;
const uploadInput = {
  action: "upload" as const,
  sources: [uploadPath],
  runId: "run-1",
  site: "https://example.test/upload",
};

function run() {
  return {
    delegatedByPerson: true,
    id: "run-1",
    profileId: "vm:workspace-1:p1",
    rootSessionId: "session-1",
    sessionId: "vm:workspace-1:s:session-1",
    site: "https://example.test",
    status: "running",
  };
}

function unusedSandboxIo(): never {
  throw new Error("File reads are mocked at the sandbox boundary");
}

function executionContext(context: DynamicResolveContext) {
  return {
    ...toolContext("browser_files"),
    getSandbox: async () => ({
      delete: unusedSandboxIo,
      id: "sandbox-1",
      readBinaryFile: unusedSandboxIo,
      readFile: unusedSandboxIo,
      readTextFile: unusedSandboxIo,
      removePath: unusedSandboxIo,
      resolvePath: (filePath: string) => filePath,
      run: unusedSandboxIo,
      setNetworkPolicy: unusedSandboxIo,
      spawn: unusedSandboxIo,
      stop: unusedSandboxIo,
      writeBinaryFile: unusedSandboxIo,
      writeFile: unusedSandboxIo,
      writeTextFile: unusedSandboxIo,
    }),
    session: {
      ...context.session,
      turn: { id: "turn-1", sequence: 1 },
    },
  } satisfies ToolContext;
}

async function resolvedFiles(context: DynamicResolveContext) {
  vi.stubEnv("BROWSER_VM_FILES_WORKSPACES", "workspace-1");
  const library = await import("@agent/lib/browser-use/files");
  vi.spyOn(library, "recordBrowserFileStep").mockImplementation(
    transfer.recordStep
  );
  const { default: files } = await import("@agent/tools/browser_files");
  const resolve = files.events["step.started"];
  if (!resolve) throw new Error("Files must resolve per step");
  const tools = await resolve({}, context);
  if (!tools || "execute" in tools)
    throw new Error("The files tool must resolve");
  return tools.browser_files;
}

function message(
  data: URL | string,
  kind = "user",
  role: "assistant" | "user" = "user"
): ModelMessage {
  if (role === "assistant") {
    return { content: [{ text: String(data), type: "text" }], role };
  }
  return Object.assign(
    {
      content: [
        {
          data,
          filename: "passport.pdf",
          mediaType: "application/pdf",
          type: "file" as const,
        },
      ],
      role,
    },
    { kind }
  );
}

function reference(
  filePath = path,
  size = 11_347_345,
  mediaType = "application/pdf"
) {
  const url = new URL("eve-sandbox:");
  url.searchParams.set("path", filePath);
  url.searchParams.set("size", String(size));
  url.searchParams.set("type", mediaType);
  return url;
}

function approvalTransport() {
  return Object.assign(
    { content: "approve", role: "user" as const },
    { kind: "tool-approval-response" }
  );
}

describe("original files for browser errands", () => {
  it("is off by default and enabled only for configured, listed workspaces", async () => {
    const { browserFilesEnabled } =
      await import("@agent/lib/browser-use/files");
    expect(browserFilesEnabled("personal:alice")).toBe(false);
    vi.stubEnv("BROWSER_VM_FILES_WORKSPACES", "personal:alice");
    vi.resetModules();
    const enabled = await import("@agent/lib/browser-use/files");
    expect(enabled.browserFilesEnabled("personal:alice")).toBe(true);
    expect(enabled.browserFilesEnabled("personal:bob")).toBe(false);
    expect(enabled.browserFilesEnabled(undefined)).toBe(false);
    configured.value = false;
    expect(enabled.browserFilesEnabled("personal:alice")).toBe(false);
  });

  it("lists the original 11.35 MB PDF and staged images even when the model sees them inline", async () => {
    const { personBrowserFiles } = await import("@agent/lib/browser-use/files");
    const image = reference(
      "/workspace/attachments/fedcba9876543210/photo.jpg",
      100,
      "image/jpeg"
    );
    expect(
      personBrowserFiles([
        message(reference()),
        message(image),
        message(reference()),
      ])
    ).toEqual([
      {
        mediaType: "application/pdf",
        name: "passport.pdf",
        path,
        size: 11_347_345,
      },
      {
        mediaType: "image/jpeg",
        name: "photo.jpg",
        path: "/workspace/attachments/fedcba9876543210/photo.jpg",
        size: 100,
      },
    ]);
  });

  it("does not accept paths from reports, memory, assistant text, remote URLs or traversal", async () => {
    const { personBrowserFiles } = await import("@agent/lib/browser-use/files");
    expect(
      personBrowserFiles([
        message(reference(), "subagent.report"),
        message(reference(), "context.browser-run"),
        message(reference(), "memory.load"),
        message(reference(), "user", "assistant"),
        message("https://example.com/passport.pdf"),
        message(reference("/workspace/attachments/0123456789abcdef/../secret")),
        message(reference("/workspace/other.txt")),
        message(reference(path, 20 * 1024 * 1024 + 1)),
        message(reference(path, 0)),
      ])
    ).toEqual([]);
  });
});

describe("browser errand file transfers", () => {
  const attachment = () =>
    message(reference(uploadPath, uploadBytes.byteLength));

  it.each([false, true])(
    "resumes the original file request with only its authenticated initiator (user-role transport: %s)",
    async (userTransport) => {
      const original = catalogContext("web", [
        attachment(),
        {
          content: "Attach my passport to this website's existing errand",
          role: "user",
        },
        {
          content: [
            {
              input: uploadInput,
              toolCallId: "file-call",
              toolName: "browser_files",
              type: "tool-call",
            },
            {
              approvalId: "approval-1",
              toolCallId: "file-call",
              type: "tool-approval-request",
            },
          ],
          role: "assistant",
        },
        {
          content: [
            {
              approvalId: "approval-1",
              approved: true,
              type: "tool-approval-response",
            },
          ],
          role: "tool",
        },
        ...(userTransport ? [approvalTransport()] : []),
      ]);
      const context = {
        ...original,
        session: {
          ...original.session,
          auth: { current: null, initiator: original.session.auth.current },
        },
      } satisfies DynamicResolveContext;
      const tool = await resolvedFiles(context);
      const ctx = executionContext(context);
      const { outboundRuleApproval } = await vi.importActual<
        typeof ruleApproval
      >("@agent/lib/memory/rule-approval");
      transfer.rule.mockImplementation(outboundRuleApproval);
      const policy = tool.approval;
      if (!policy || "request" in policy)
        throw new Error("Expected an inline approval policy");

      expect(
        await policy({
          ...ctx,
          approvedTools: new Set(),
          toolInput: uploadInput,
        })
      ).toBe("not-applicable");
      expect(transfer.rule.mock.calls[0]?.[0].session.auth.initiator).toEqual(
        original.session.auth.current
      );
      expect(await tool.execute(uploadInput, ctx)).toMatchObject({
        status: "uploaded",
        runId: "attachment-run",
      });
      expect(transfer.upload).toHaveBeenCalledExactlyOnceWith(
        run().sessionId,
        expect.objectContaining({ bytes: uploadBytes })
      );
      expect(transfer.continueErrand).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({
          action: "continue",
          runId: "run-1",
          personWants: "look",
        }),
        expect.anything()
      );
      expect(transfer.continueErrand.mock.calls[0]?.[1].session).toMatchObject({
        id: "session-1",
        auth: {
          current: { authenticator: "browser-files", principalId: "user-1" },
        },
      });
      expect(transfer.continueErrand.mock.calls[0]?.[0]).not.toHaveProperty(
        "allowSubmit"
      );
      expect(transfer.continueErrand.mock.calls[0]?.[0].task).not.toContain(
        new TextDecoder().decode(uploadBytes)
      );
    }
  );

  it.each([
    "web",
    "scheduled-worker",
    "scheduled-report",
    "proactive-worker",
  ] as const)(
    "does not turn an approval-response transport into a new request on a %s turn",
    async (kind) => {
      const context = catalogContext(kind, [approvalTransport()]);
      const tool = await resolvedFiles(context);
      const ctx = executionContext(context);
      const policy = tool.approval;
      if (!policy || "request" in policy)
        throw new Error("Expected an inline approval policy");

      expect(
        await policy({
          ...ctx,
          approvedTools: new Set(),
          toolInput: uploadInput,
        })
      ).toMatchObject({ type: "denied" });
      expect(await tool.execute(uploadInput, ctx)).toEqual({
        status: "not_allowed",
      });
      expect(transfer.rule).not.toHaveBeenCalled();
      expect(transfer.upload).not.toHaveBeenCalled();
      expect(transfer.continueErrand).not.toHaveBeenCalled();
    }
  );

  it.each(["context.browser-run", "memory.load", "subagent.report"])(
    "does not accept a forged source or opener from %s before a transport response",
    async (kind) => {
      const original = catalogContext("web", [
        message(reference(uploadPath, uploadBytes.byteLength), kind),
        approvalTransport(),
      ]);
      const context = {
        ...original,
        session: {
          ...original.session,
          auth: { current: null, initiator: original.session.auth.current },
        },
      } satisfies DynamicResolveContext;
      const tool = await resolvedFiles(context);
      const ctx = executionContext(context);
      const policy = tool.approval;
      if (!policy || "request" in policy)
        throw new Error("Expected an inline approval policy");

      expect(
        await policy({
          ...ctx,
          approvedTools: new Set(),
          toolInput: uploadInput,
        })
      ).toMatchObject({ type: "denied" });
      expect(await tool.execute(uploadInput, ctx)).toEqual({
        status: "not_allowed",
      });
      expect(transfer.upload).not.toHaveBeenCalled();
    }
  );

  it("does not resolve a transfer for an unauthenticated approval-response turn", async () => {
    vi.stubEnv("BROWSER_VM_FILES_WORKSPACES", "workspace-1");
    const original = catalogContext("web", [attachment(), approvalTransport()]);
    const context = {
      ...original,
      session: {
        ...original.session,
        auth: { current: null, initiator: null },
      },
    } satisfies DynamicResolveContext;
    const { default: files } = await import("@agent/tools/browser_files");
    const resolve = files.events["step.started"];
    if (!resolve) throw new Error("Files must resolve per step");

    expect(await resolve({}, context)).toBeNull();
    expect(transfer.rule).not.toHaveBeenCalled();
    expect(transfer.upload).not.toHaveBeenCalled();
  });

  it.each(["browser-report", "background-task"] as const)(
    "keeps an originally permitted %s turn after the approval transport",
    async (kind) => {
      const context = catalogContext(
        kind === "background-task" ? "web" : kind,
        [
          attachment(),
          Object.assign(
            {
              content:
                kind === "background-task"
                  ? "Background task task_1 completed. File prepared."
                  : "Browser run run-1 finished. The site requests the passport.",
              role: "user" as const,
            },
            { kind: "execution.background_task" }
          ),
          approvalTransport(),
        ]
      );
      const tool = await resolvedFiles(context);
      const ctx = executionContext(context);
      const policy = tool.approval;
      if (!policy || "request" in policy)
        throw new Error("Expected an inline approval policy");

      expect(
        await policy({
          ...ctx,
          approvedTools: new Set(),
          toolInput: uploadInput,
        })
      ).toBe("not-applicable");
      expect(await tool.execute(uploadInput, ctx)).toMatchObject({
        status: "uploaded",
      });
      expect(transfer.upload).toHaveBeenCalledExactlyOnceWith(
        run().sessionId,
        expect.objectContaining({ bytes: uploadBytes })
      );
      expect(transfer.continueErrand).toHaveBeenCalledOnce();
    }
  );

  it.each(["untrusted-site", "browser-result"])(
    "does not restore person permissions for an unvalidated %s caller",
    async (authenticator) => {
      const original = catalogContext("web", [
        attachment(),
        approvalTransport(),
      ]);
      const context = {
        ...original,
        session: {
          ...original.session,
          auth: {
            current: { ...original.session.auth.current, authenticator },
            initiator: original.session.auth.current,
          },
        },
      } satisfies DynamicResolveContext;
      const tool = await resolvedFiles(context);
      const ctx = executionContext(context);
      const policy = tool.approval;
      if (!policy || "request" in policy)
        throw new Error("Expected an inline approval policy");

      expect(
        await policy({
          ...ctx,
          approvedTools: new Set(),
          toolInput: uploadInput,
        })
      ).toMatchObject({ type: "denied" });
      expect(await tool.execute(uploadInput, ctx)).toEqual({
        status: "not_allowed",
      });
      expect(transfer.rule).not.toHaveBeenCalled();
      expect(transfer.upload).not.toHaveBeenCalled();
      expect(transfer.continueErrand).not.toHaveBeenCalled();
    }
  );

  it.each(["web", "browser-report", "background-task"] as const)(
    "uploads a requested passport in an existing errand without a card on a %s turn",
    async (kind) => {
      const context = catalogContext(
        kind === "background-task" ? "web" : kind,
        [
          attachment(),
          ...(kind === "background-task"
            ? [
                Object.assign(
                  {
                    content: "Background task task_1 completed. File prepared.",
                    role: "user" as const,
                  },
                  { kind: "execution.background_task" }
                ),
              ]
            : []),
        ]
      );
      const tool = await resolvedFiles(context);
      const ctx = executionContext(context);
      const policy = tool.approval;
      if (!policy || "request" in policy)
        throw new Error("Expected an inline approval policy");

      expect(
        await policy({
          ...ctx,
          approvedTools: new Set(),
          toolInput: uploadInput,
        })
      ).toBe("not-applicable");
      expect(transfer.rule).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({ toolInput: uploadInput }),
        JSON.stringify(uploadInput)
      );
      const result = await tool.execute(uploadInput, ctx);

      expect(result).toMatchObject({
        status: "uploaded",
        runId: "attachment-run",
      });
      expect(transfer.upload).toHaveBeenCalledExactlyOnceWith(
        run().sessionId,
        expect.objectContaining({ bytes: uploadBytes, site: run().site })
      );
      expect(transfer.continueErrand).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({ action: "continue", runId: "run-1" }),
        expect.anything()
      );
      expect(transfer.continueErrand.mock.calls[0]?.[1].session).toMatchObject({
        id: "session-1",
        auth: { current: { authenticator: "browser-files" } },
      });
      expect(transfer.continueErrand.mock.calls[0]?.[0]).not.toHaveProperty(
        "allowSubmit"
      );
      expect(transfer.continueErrand.mock.calls[0]?.[0]).not.toHaveProperty(
        "allowPayment"
      );
      const task = transfer.continueErrand.mock.calls[0]?.[0].task;
      expect(task).toContain("Attach only these files");
      expect(task).toContain(
        "Do not enter other personal data, submit a form, pay"
      );
      expect(task).not.toContain(new TextDecoder().decode(uploadBytes));
      expect(task).not.toContain("approval");
    }
  );

  it.each(["web", "browser-report"] as const)(
    "keeps the saved-rule denial on a %s turn",
    async (kind) => {
      const context = catalogContext(kind, [attachment()]);
      const tool = await resolvedFiles(context);
      const ctx = executionContext(context);
      const denied = {
        reason: "A saved rule prohibits this upload",
        type: "denied" as const,
      };
      transfer.rule.mockResolvedValue(denied);
      const policy = tool.approval;
      if (!policy || "request" in policy)
        throw new Error("Expected an inline approval policy");

      expect(
        await policy({
          ...ctx,
          approvedTools: new Set(),
          toolInput: uploadInput,
        })
      ).toEqual(denied);
      expect(transfer.upload).not.toHaveBeenCalled();
      expect(transfer.continueErrand).not.toHaveBeenCalled();
    }
  );

  it.each([true, false])(
    "checks processed-file ownership when continuing file preparation (owned: %s)",
    async (owned) => {
      vi.stubEnv("BROWSER_VM_FILES_WORKSPACES", "workspace-1");
      const { sandboxFileLinkSignature } =
        await import("@agent/lib/sandbox/keys");
      const id = "1".repeat(24);
      const name = "passport-upload.pdf";
      const source = `https://example.com/eve/v1/sandbox-files/${id}/${name}?sig=${sandboxFileLinkSignature(`sandbox/files/${id}/${name}`)}`;
      const context = catalogContext("web", [
        attachment(),
        Object.assign(
          {
            content: `Background task task_1 completed. Prepared file: ${source}`,
            role: "user" as const,
          },
          { kind: "execution.background_task" }
        ),
      ]);
      const tool = await resolvedFiles(context);
      const ctx = executionContext(context);
      const input = { ...uploadInput, sources: [source] };
      transfer.readShared.mockResolvedValue(
        owned
          ? { bytes: uploadBytes, mediaType: "application/pdf", name }
          : undefined
      );
      const policy = tool.approval;
      if (!policy || "request" in policy)
        throw new Error("Expected an inline approval policy");

      expect(
        await policy({ ...ctx, approvedTools: new Set(), toolInput: input })
      ).toBe("not-applicable");
      expect(await tool.execute(input, ctx)).toMatchObject({
        status: owned ? "uploaded" : "file_unavailable",
      });
      expect(transfer.readShared).toHaveBeenCalledExactlyOnceWith(source, {
        sessionId: "session-1",
        workspaceId: "workspace-1",
      });
      expect(transfer.readOriginal).not.toHaveBeenCalled();
      expect(transfer.upload).toHaveBeenCalledTimes(owned ? 1 : 0);
      expect(transfer.continueErrand).toHaveBeenCalledTimes(owned ? 1 : 0);
    }
  );

  it.each([
    "scheduled-worker",
    "scheduled-report",
    "proactive-worker",
  ] as const)(
    "denies transfers outside the allowed turn boundary on a %s turn",
    async (kind) => {
      const context = catalogContext(kind, [attachment()]);
      const tool = await resolvedFiles(context);
      const ctx = executionContext(context);
      const policy = tool.approval;
      if (!policy || "request" in policy)
        throw new Error("Expected an inline approval policy");

      expect(
        await policy({
          ...ctx,
          approvedTools: new Set(),
          toolInput: uploadInput,
        })
      ).toMatchObject({ type: "denied" });
      expect(await tool.execute(uploadInput, ctx)).toEqual({
        status: "not_allowed",
      });
      expect(transfer.rule).not.toHaveBeenCalled();
      expect(transfer.upload).not.toHaveBeenCalled();
    }
  );

  it("denies a caller from a different workspace before any file transfer", async () => {
    const context = catalogContext("web", [attachment()]);
    const tool = await resolvedFiles(context);
    const wrongCaller = catalogContext("web");
    wrongCaller.session.auth.current.attributes.workspaceId = "workspace-2";
    const ctx = executionContext(wrongCaller);

    expect(await tool.execute(uploadInput, ctx)).toEqual({
      status: "not_allowed",
    });
    expect(transfer.upload).not.toHaveBeenCalled();
  });

  it.each([
    "https://external.test/passport.pdf",
    "/workspace/attachments/0123456789abcdef/not-listed.pdf",
  ])("rejects an unlisted or arbitrary external source %s", async (source) => {
    const context = catalogContext("web", [attachment()]);
    const tool = await resolvedFiles(context);

    expect(
      await tool.execute(
        { ...uploadInput, sources: [source] },
        executionContext(context)
      )
    ).toMatchObject({ status: "unknown_file" });
    expect(transfer.readRun).not.toHaveBeenCalled();
    expect(transfer.upload).not.toHaveBeenCalled();
  });

  it.each([
    { rootSessionId: "another-chat" },
    { sessionId: "vm:workspace-2:s:session-1" },
    { sessionId: "external-browser-session" },
    { site: "http://example.test" },
    { site: "https://another.test" },
    { site: "https://user:password@example.test" },
    { status: "stopped" },
  ])("keeps the run ownership and HTTPS-site boundary: %j", async (row) => {
    const context = catalogContext("web", [attachment()]);
    const tool = await resolvedFiles(context);
    transfer.readRun.mockResolvedValue({ ...run(), ...row });

    expect(
      await tool.execute(uploadInput, executionContext(context))
    ).toMatchObject({
      status: "wrong_browser",
    });
    expect(transfer.readOriginal).not.toHaveBeenCalled();
    expect(transfer.upload).not.toHaveBeenCalled();
    expect(transfer.continueErrand).not.toHaveBeenCalled();
  });

  it.each([
    new Uint8Array(uploadBytes.byteLength),
    new Uint8Array(uploadBytes.byteLength - 1),
    null,
    "oversize" as const,
  ])(
    "refuses missing, oversized or changed original bytes: %j",
    async (bytes) => {
      const context = catalogContext("web", [attachment()]);
      const tool = await resolvedFiles(context);
      transfer.readOriginal.mockResolvedValue(bytes);

      expect(
        await tool.execute(uploadInput, executionContext(context))
      ).toMatchObject({
        status: "file_unavailable",
      });
      expect(transfer.upload).not.toHaveBeenCalled();
      expect(transfer.continueErrand).not.toHaveBeenCalled();
    }
  );
});

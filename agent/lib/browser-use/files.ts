import type { ModelMessage } from "ai";
import { z } from "zod";
import { defineState } from "eve/context";
import { startsTurn } from "@agent/lib/delivery/turn-sends";
import { documentByteCap } from "@agent/lib/inbound-media/media-type";
import { namedAttachmentPaths } from "@agent/lib/sandbox/inbox";
import { isSharedFileLink } from "@agent/lib/sandbox/files";
import { env } from "@shared/environment";
import { browserUseConfigured } from "./client";
import { isPersonMessage } from "./said";
import type { StepIdentity } from "@agent/lib/turn-kind/step";

const browserFileStep = defineState<{
  paths: string[];
  sessionId: string;
  stepIndex: number | null;
  turnId: string | null;
}>("bro.browser-file-step", () => ({
  paths: [],
  sessionId: "",
  stepIndex: null,
  turnId: null,
}));

export function recordBrowserFileStep(paths: string[], step: StepIdentity) {
  browserFileStep.update(() => ({
    paths,
    sessionId: step.sessionId,
    stepIndex: step.stepIndex ?? null,
    turnId: step.turnId ?? null,
  }));
}

export function browserFileStepPaths(step: StepIdentity) {
  const record = browserFileStep.get();
  return record.sessionId === step.sessionId &&
    record.turnId === step.turnId &&
    record.stepIndex === step.stepIndex
    ? record.paths
    : [];
}

const referenceSchema = z.union([z.instanceof(URL), z.string()]);
const stagedFileSchema = z.object({
  mediaType: z.string().min(1),
  path: z.string().min(1),
  size: z
    .string()
    .regex(/^\d+$/u)
    .transform(Number)
    .pipe(z.number().int().positive().max(documentByteCap)),
});

export function browserFilesEnabled(workspaceId: string | undefined) {
  const list = env.BROWSER_VM_FILES_WORKSPACES ?? [];
  return (
    workspaceId !== undefined &&
    (list.includes("*") || list.includes(workspaceId)) &&
    browserUseConfigured()
  );
}

export function personBrowserFiles(messages: readonly ModelMessage[]) {
  const files = new Map<
    string,
    z.infer<typeof stagedFileSchema> & { readonly name: string }
  >();
  for (const message of messages) {
    if (
      !startsTurn(message) ||
      !isPersonMessage(message) ||
      !Array.isArray(message.content)
    ) {
      continue;
    }
    for (const part of message.content) {
      if (part.type !== "file") continue;
      const reference = referenceSchema.safeParse(part.data).data;
      if (reference === undefined) continue;
      const url = URL.parse(String(reference));
      if (url?.protocol !== "eve-sandbox:") continue;
      const file = stagedFileSchema.safeParse({
        mediaType: url.searchParams.get("type"),
        path: url.searchParams.get("path"),
        size: url.searchParams.get("size"),
      }).data;
      if (
        file === undefined ||
        namedAttachmentPaths(file.path).at(0) !== file.path
      ) {
        continue;
      }
      const name = file.path.split("/").at(-1);
      if (name !== undefined) files.set(file.path, { ...file, name });
    }
  }
  return [...files.values()];
}

export function reportedSharedFileLinks(messages: readonly ModelMessage[]) {
  const links = new Set<string>();
  for (const message of messages) {
    const kind = z.object({ kind: z.string() }).safeParse(message).data?.kind;
    if (
      message.role !== "user" ||
      (!isPersonMessage(message) && kind !== "execution.background_task")
    )
      continue;
    const text = Array.isArray(message.content)
      ? message.content
          .flatMap((part) => (part.type === "text" ? [part.text] : []))
          .join("\n")
      : message.content;
    for (const [link] of text.matchAll(/https:\/\/[^\s<>"')\]]+/gu)) {
      if (isSharedFileLink(link)) links.add(link);
    }
  }
  return [...links].slice(-50);
}

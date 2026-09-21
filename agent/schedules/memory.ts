import { defineSchedule } from "eve/schedules";
import {
  claimMemorySyncJobs,
  completeMemorySyncJob,
  failMemorySyncJob,
  readMemorySyncSource,
} from "@db/services/memory/sync";
import { expireMemories } from "@db/services/memory/records";
import {
  addIndexedMemory,
  deleteIndexedMemory,
  providerErrorCode,
  supermemoryConfigured,
} from "@agent/lib/memory/supermemory";

export default defineSchedule({
  cron: "* * * * *",
  run({ waitUntil }) {
    waitUntil(maintainMemory());
  },
});

async function maintainMemory() {
  await expireMemories();
  if (!supermemoryConfigured()) return;
  const jobs = await claimMemorySyncJobs();
  await Promise.all(jobs.map(processMemorySyncJob));
}

export async function processMemorySyncJob(
  job: Awaited<ReturnType<typeof claimMemorySyncJobs>>[number]
) {
  try {
    const { record, scope } = await readMemorySyncSource(job);
    const shouldUpload =
      job.desiredPresent &&
      scope?.semanticIndexEnabled === true &&
      scope.generation === job.generation &&
      record?.revision === job.revision &&
      record.generation === job.generation &&
      record.content !== null &&
      !record.content.localOnly;
    if (!shouldUpload) {
      await deleteIndexedMemory(job.providerDocumentId ?? job.customId);
      await completeMemorySyncJob(job, null);
      return;
    }
    const content = record.content;
    if (!content) {
      await failMemorySyncJob(job, "missing_content");
      return;
    }
    const response = await addIndexedMemory({
      aliases: content.aliases,
      category: content.category,
      content: content.text,
      customId: job.customId,
      generation: job.generation,
      recordIndex: job.recordIndex,
      revision: job.revision,
      scopeKey: job.scopeKey,
      workspaceId: job.workspaceId,
    });
    const latest = await readMemorySyncSource(job);
    const stale =
      latest.record?.revision !== job.revision ||
      latest.record.generation !== job.generation ||
      latest.record.content === null;
    if (stale) {
      await deleteIndexedMemory(response.id);
      return;
    }
    await completeMemorySyncJob(job, response.id);
  } catch (error) {
    const providerError =
      error instanceof Error ? error : new Error("Unknown provider error");
    console.warn("[memory-index] reconciliation failed", {
      errorCode: providerErrorCode(providerError),
      recordIndex: job.recordIndex,
      revision: job.revision,
    });
    await failMemorySyncJob(job, providerErrorCode(providerError));
  }
}

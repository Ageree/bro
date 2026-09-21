import { defineMemory } from "eve/memory";
import { fileMemory } from "eve/memory/file";
import { vercelBlob } from "eve/memory/file/vercel";
import {
  preserveProfileMemoryCancellation,
  resolveProfileMemoryBackend,
  resolveProfileMemoryScope,
} from "../lib/profile-memory";
import { createProfileMemoryProvider } from "@agent/lib/memory/profile";
import { env } from "@shared/environment";

const backend = resolveProfileMemoryBackend(env);
const legacyProvider = preserveProfileMemoryCancellation(
  backend.kind === "vercel-blob"
    ? fileMemory({
        backend: vercelBlob(backend.options),
      })
    : fileMemory()
);

export default defineMemory({
  description: "Remember stable facts and preferences about the current user.",
  provider: createProfileMemoryProvider(
    legacyProvider,
    backend.kind === "vercel-blob" ? vercelBlob(backend.options) : null
  ),
  scope: resolveProfileMemoryScope,
});

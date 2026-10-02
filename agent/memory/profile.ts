import { defineMemory } from "eve/memory";
import { fileMemory } from "eve/memory/file";
import {
  postgresMemoryDocuments,
  preserveProfileMemoryCancellation,
  resolveProfileMemoryScope,
} from "../lib/profile-memory";
import { createProfileMemoryProvider } from "@agent/lib/memory/profile";

const legacyProvider = preserveProfileMemoryCancellation(
  fileMemory({ backend: postgresMemoryDocuments })
);

export default defineMemory({
  description: "Remember stable facts and preferences about the current user.",
  provider: createProfileMemoryProvider(
    legacyProvider,
    postgresMemoryDocuments
  ),
  scope: resolveProfileMemoryScope,
});

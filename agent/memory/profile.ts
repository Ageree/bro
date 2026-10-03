import { defineMemory } from "eve/memory";
import {
  postgresMemoryDocuments,
  resolveProfileMemoryScope,
} from "../lib/profile-memory";
import { createProfileMemoryProvider } from "@agent/lib/memory/profile";
import { memoryNamespace } from "@agent/lib/memory/namespace";

export default defineMemory({
  description: "Remember stable facts and preferences about the current user.",
  namespace: memoryNamespace("profile"),
  provider: createProfileMemoryProvider(postgresMemoryDocuments),
  scope: resolveProfileMemoryScope,
});

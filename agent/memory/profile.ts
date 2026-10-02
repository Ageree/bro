import { defineMemory } from "eve/memory";
import {
  postgresMemoryDocuments,
  resolveProfileMemoryScope,
} from "../lib/profile-memory";
import { createProfileMemoryProvider } from "@agent/lib/memory/profile";

export default defineMemory({
  description: "Remember stable facts and preferences about the current user.",
  provider: createProfileMemoryProvider(postgresMemoryDocuments),
  scope: resolveProfileMemoryScope,
});

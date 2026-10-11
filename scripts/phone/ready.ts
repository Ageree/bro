import { registerApplicationModuleResolution } from "../lib/module-resolution.ts";

registerApplicationModuleResolution();

try {
  const { env } = await import("@shared/environment");
  const { requirePhoneAgentReady } = await import("@shared/phone/elevenlabs");
  await requirePhoneAgentReady();
  console.log(
    `Phone agent ${env.PHONE_AGENT_ID ?? "unknown"} is ready for voice.`
  );
} catch (error) {
  console.error(
    error instanceof Error
      ? error.message
      : "Phone agent readiness check did not complete."
  );
  process.exitCode = 1;
}

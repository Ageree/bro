import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { voiceTalkEnabled } from "@shared/voice/pilot";
import { requireRequestScope } from "@web/auth/request-scope";
import { VoiceTalk } from "./_components/voice-talk";

export const metadata: Metadata = { title: "Голос" };

/**
 * A voice conversation with Bro, opened straight into listening: the
 * iPhone's Action Button opens this page through a shortcut. Outside the
 * pilot (VOICE_WORKSPACES) the page does not exist.
 */
export default async function TalkPage() {
  const scope = await requireRequestScope();
  if (!voiceTalkEnabled(scope.workspaceId)) notFound();
  return <VoiceTalk />;
}

import { notFound } from "next/navigation";
import { ChatSession } from "./_components/chat-session";
import { readChat } from "@db/services/chats";
import { isSessionOwned } from "@db/services/sessions";
import { taskFilesEnabled } from "@shared/sandbox/pilot";
import { requireRequestScope } from "@web/auth/request-scope";

export default async function ChatSessionPage({
  params,
}: PageProps<"/chat/[sessionId]">) {
  const { sessionId } = await params;
  const scope = await requireRequestScope();
  const chat = await readChat(scope, sessionId);
  // eve answers only the owner of a session: for anyone else the chat would
  // load nothing, and an empty one to write into says nothing of why. A
  // session of another workspace is as unknown as one that never was.
  if (!chat && !(await isSessionOwned(scope, sessionId))) notFound();
  return (
    <ChatSession
      filesPilot={taskFilesEnabled(scope.workspaceId)}
      initialUsage={chat?.usage}
      key={sessionId}
      sessionId={sessionId}
    />
  );
}

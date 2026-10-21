import { ChatSession } from "./_components/chat-session";
import { readChat } from "@db/services/chats";
import { taskFilesEnabled } from "@shared/sandbox/pilot";
import { isAdminScope } from "@web/auth/admin";
import { requireRequestScope } from "@web/auth/request-scope";

export default async function ChatSessionPage({
  params,
}: PageProps<"/chat/[sessionId]">) {
  const { sessionId } = await params;
  const scope = await requireRequestScope();
  const [chat, showInternals] = await Promise.all([
    readChat(scope, sessionId),
    isAdminScope(scope),
  ]);
  return (
    <ChatSession
      filesPilot={taskFilesEnabled(scope.workspaceId)}
      initialUsage={chat?.usage}
      key={sessionId}
      sessionId={sessionId}
      showInternals={showInternals}
    />
  );
}

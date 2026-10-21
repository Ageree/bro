import type { Metadata } from "next";
import { taskFilesEnabled } from "@shared/sandbox/pilot";
import { requireRequestScope } from "@web/auth/request-scope";
import { NewChat } from "./_components/new-chat";

export const metadata: Metadata = { title: "Чат" };

/** The empty chat is a plate on paper: the title, then the line you write on. */
export default async function NewChatPage() {
  const scope = await requireRequestScope();
  return (
    <div className="flex h-full min-h-0 items-center justify-center overflow-y-auto px-bro-pad pb-6">
      <div className="w-full max-w-xl bro-plate p-6 sm:p-8">
        <h1 className="type-doc-title">Чат</h1>
        <p className="type-fine mt-[0.55rem] text-muted-foreground">
          Тот же Bro, что в мессенджере, — с той же памятью.
        </p>
        <div className="mt-6">
          <NewChat filesPilot={taskFilesEnabled(scope.workspaceId)} />
        </div>
      </div>
    </div>
  );
}

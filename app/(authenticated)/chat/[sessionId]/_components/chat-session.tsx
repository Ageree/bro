"use client";

import { useState } from "react";
import type { ChatUsage } from "@shared/chat/schema";
import type { TraceView } from "../_lib/trace-view";
import { SubagentPanel } from "./activity";
import { ChatConversation } from "./conversation";
import { ChatInput } from "./input";
import { useSessionAgent } from "./use-session-agent";

export function ChatSession({
  filesPilot,
  initialUsage,
  sessionId,
}: {
  readonly filesPilot: boolean;
  readonly initialUsage?: ChatUsage;
  readonly sessionId: string;
}) {
  const [traceView, setTraceView] = useState<TraceView>("imessage");
  const agent = useSessionAgent(sessionId);

  return (
    // On a phone the root stacks: the activity button takes a row of its own
    // above the conversation, so it never lies over a message.
    <div className="relative flex h-full min-h-0 flex-col overflow-hidden bg-background text-foreground md:flex-row">
      <div className="relative flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
        <ChatConversation
          agent={agent}
          initial={false}
          history={{
            hasOlder: agent.hasOlder,
            isLoadingOlder: agent.isLoadingOlder,
            loadOlder: agent.loadOlder,
          }}
          sessionId={sessionId}
          traceView={traceView}
        />
        <ChatInput
          agent={agent}
          filesPilot={filesPilot}
          sessionId={sessionId}
        />
      </div>
      <SubagentPanel
        events={agent.events}
        historyComplete={!agent.hasOlder}
        initialUsage={initialUsage}
        onTraceViewChange={setTraceView}
        sessionId={sessionId}
        traceView={traceView}
      />
    </div>
  );
}

import {
  PromptInput,
  PromptInputBody,
  PromptInputFooter,
  type PromptInputMessage,
  PromptInputSubmit,
  PromptInputTextarea,
  PromptInputTools,
} from "@web/components/ai-elements/prompt-input";
import {
  paperComposerClassName,
  paperComposerSubmitClassName,
} from "../../../_lib/composer";
import { messageContent } from "../../../_lib/message-input";
import { cn } from "@web/components/class-names";
import { api } from "@web/trpc/client";
import type { ChatAgent } from "../chat-agent";
import { ShareLocationButton } from "./location";

export function ChatInput({
  agent,
  sessionId,
}: {
  readonly agent: Pick<ChatAgent, "cancel" | "data" | "send" | "status">;
  readonly sessionId?: string;
}) {
  const { mutate: saveChat } = api.chats.save.useMutation();
  const isBusy = agent.status === "submitted" || agent.status === "streaming";
  const isRestoring =
    agent.status === "resuming" && agent.data.messages.length === 0;

  const handleSubmit = async (message: PromptInputMessage) => {
    const text = message.text.trim();
    if (
      (text.length === 0 && message.files.length === 0) ||
      agent.status === "submitted" ||
      isRestoring
    ) {
      return;
    }

    if (sessionId !== undefined) saveChat({ sessionId });
    await agent.send(
      messageContent(message),
      isBusy ? { turnPolicy: "steer" } : undefined
    );
  };

  return (
    // The paper fades in under the composer across the whole width, so
    // scrolling text never shows through beside it.
    <div className="pointer-events-none absolute inset-x-0 bottom-0 z-20 bg-linear-to-t from-background via-background to-transparent px-4 pt-8 pb-6 sm:px-6">
      <PromptInput
        className={cn(
          paperComposerClassName,
          "pointer-events-auto mx-auto max-w-3xl"
        )}
        compact
        onSubmit={handleSubmit}
      >
        <PromptInputBody>
          <PromptInputTextarea
            className="min-h-0"
            disabled={agent.status === "submitted"}
            placeholder="Напиши Bro…"
          />
        </PromptInputBody>
        <PromptInputFooter>
          <PromptInputTools>
            <ShareLocationButton
              disabled={isRestoring || agent.status === "submitted"}
              onShared={async (text) => {
                if (sessionId !== undefined) saveChat({ sessionId });
                await agent.send(
                  text,
                  isBusy ? { turnPolicy: "steer" } : undefined
                );
              }}
            />
          </PromptInputTools>
          <PromptInputSubmit
            className={paperComposerSubmitClassName}
            disabled={isRestoring}
            onStop={() => void agent.cancel()}
            status={isBusy ? agent.status : undefined}
            variant="paper"
          />
        </PromptInputFooter>
      </PromptInput>
    </div>
  );
}

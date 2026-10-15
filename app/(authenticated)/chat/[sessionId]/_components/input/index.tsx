import { useState } from "react";
import {
  PromptInput,
  PromptInputBody,
  PromptInputFooter,
  type PromptInputMessage,
  PromptInputSubmit,
  PromptInputTextarea,
  PromptInputTools,
} from "@web/components/ai-elements/prompt-input";
import { webMessageFiles } from "@shared/chat/web-files";
import {
  ComposerAttachButton,
  ComposerAttachments,
  ComposerNotice,
} from "../../../_components/composer-files";
import {
  pilotAccept,
  refusalText,
  sendFailure,
} from "../../../_lib/attachments";
import {
  paperComposerClassName,
  paperComposerSubmitClassName,
} from "../../../_lib/composer";
import { messageContent } from "../../../_lib/message-input";
import { api } from "@web/trpc/client";
import type { ChatAgent } from "../chat-agent";

export function ChatInput({
  agent,
  filesPilot,
  sessionId,
}: {
  readonly agent: Pick<ChatAgent, "cancel" | "data" | "send" | "status">;
  readonly filesPilot: boolean;
  readonly sessionId?: string;
}) {
  const { mutate: saveChat } = api.chats.save.useMutation();
  const [notice, setNotice] = useState<string>();
  const isBusy = agent.status === "submitted" || agent.status === "streaming";
  const isRestoring =
    agent.status === "resuming" && agent.data.messages.length === 0;
  // While a turn streams or the chat catches up after a steer, an operation
  // runs: a message then joins it instead of waiting for it.
  const steer = isBusy || agent.status === "resuming";

  const handleSubmit = async (message: PromptInputMessage) => {
    const text = message.text.trim();
    if (text.length === 0 && message.files.length === 0) return;
    // A rejection keeps the message in the composer.
    if (agent.status === "submitted" || isRestoring) {
      throw new Error("The conversation is not ready for a message yet.");
    }
    setNotice(undefined);

    if (sessionId !== undefined) saveChat({ sessionId });
    try {
      await agent.send(
        messageContent(message),
        steer ? { turnPolicy: "steer" } : undefined
      );
    } catch (cause) {
      const error =
        cause instanceof Error
          ? cause
          : new Error("Sending failed.", { cause });
      const outcome = sendFailure(error);
      setNotice(outcome.text);
      if (outcome.keep) throw error;
    }
  };

  return (
    <div className="absolute bottom-0 left-1/2 z-20 mx-auto w-full max-w-3xl -translate-x-1/2 bg-linear-to-t from-background via-background to-transparent px-4 pt-4 pb-6 sm:px-6">
      <PromptInput
        accept={filesPilot ? pilotAccept : undefined}
        className={paperComposerClassName}
        compact
        maxFileSize={webMessageFiles.maxFileSize}
        maxFiles={webMessageFiles.maxFiles}
        maxTotalSize={webMessageFiles.maxTotalSize}
        multiple
        onError={(error) => {
          setNotice(refusalText(error.code));
        }}
        onSubmit={handleSubmit}
      >
        <ComposerAttachments />
        <PromptInputBody>
          <PromptInputTextarea
            className="min-h-0"
            disabled={agent.status === "submitted"}
            placeholder="Напиши Bro…"
          />
        </PromptInputBody>
        <PromptInputFooter>
          <PromptInputTools>
            {filesPilot ? (
              <ComposerAttachButton disabled={isRestoring} />
            ) : null}
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
      <ComposerNotice text={notice} />
    </div>
  );
}

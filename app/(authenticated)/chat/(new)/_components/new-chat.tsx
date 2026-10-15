"use client";

import { useEveAgent } from "eve/react";
import { useRouter } from "next/navigation";
import { useRef, useState } from "react";
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
} from "../../_components/composer-files";
import { pilotAccept, refusalText, sendFailure } from "../../_lib/attachments";
import {
  paperComposerClassName,
  paperComposerSubmitClassName,
} from "../../_lib/composer";
import { chatTitle, messageContent } from "../../_lib/message-input";
import { cn } from "@web/components/class-names";
import { api } from "@web/trpc/client";

export function NewChat({ filesPilot }: { readonly filesPilot: boolean }) {
  const router = useRouter();
  const { mutateAsync: saveChat } = api.chats.save.useMutation();
  const [notice, setNotice] = useState<string>();
  // `send` never throws: eve hands a failure to `onError` instead.
  const failure = useRef<{ error?: Error }>({});
  const pendingTitle = useRef<string | undefined>(undefined);
  const isSubmitting = useRef(false);
  const navigationStarted = useRef(false);
  const agent = useEveAgent({
    onError(error) {
      failure.current = { error };
    },
    onSessionChange(session) {
      if (session === undefined || navigationStarted.current) return;
      navigationStarted.current = true;
      const path = `/chat/${encodeURIComponent(session.sessionId)}`;
      void saveChat({
        sessionId: session.sessionId,
        title: pendingTitle.current,
      })
        .catch(() => undefined)
        .then(() => {
          router.replace(path);
          return undefined;
        });
      pendingTitle.current = undefined;
    },
  });

  const handleSubmit = async (message: PromptInputMessage) => {
    const text = message.text.trim();
    if (text.length === 0 && message.files.length === 0) return;
    // A rejection keeps the message in the composer.
    if (isSubmitting.current) {
      throw new Error("A message is already on its way.");
    }
    setNotice(undefined);
    failure.current = {};
    isSubmitting.current = true;
    pendingTitle.current = chatTitle(message);
    try {
      await agent.send(messageContent(message));
    } finally {
      isSubmitting.current = false;
    }
    const { error } = failure.current;
    // Once eve took the message there is a session and the page moves to it,
    // where the conversation shows how the turn went.
    if (error === undefined || navigationStarted.current) return;
    const outcome = sendFailure(error);
    setNotice(outcome.text);
    if (outcome.keep) {
      pendingTitle.current = undefined;
      throw error;
    }
  };

  return (
    <div>
      <PromptInput
        accept={filesPilot ? pilotAccept : undefined}
        className={cn(
          paperComposerClassName,
          "[&_[data-slot=input-group]]:shadow-none"
        )}
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
          <PromptInputTextarea className="min-h-0" placeholder="Напиши Bro…" />
        </PromptInputBody>
        <PromptInputFooter>
          <PromptInputTools>
            {filesPilot ? <ComposerAttachButton /> : null}
          </PromptInputTools>
          <PromptInputSubmit
            className={paperComposerSubmitClassName}
            variant="paper"
          />
        </PromptInputFooter>
      </PromptInput>
      <ComposerNotice text={notice} />
    </div>
  );
}

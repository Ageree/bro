import { ClientError } from "eve/client";
import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, type Mock, vi } from "vitest";
import type { PromptInputMessage } from "@web/components/ai-elements/prompt-input";
import type { ChatAgent } from "../chat-agent";

interface Mocks {
  promptSubmit:
    | ((message: PromptInputMessage) => void | Promise<void>)
    | undefined;
  saveChat: Mock<(input: { sessionId: string }) => void>;
}

const mocks = vi.hoisted<Mocks>(() => ({
  promptSubmit: undefined,
  saveChat: vi.fn<(input: { sessionId: string }) => void>(),
}));

vi.mock("@web/trpc/client", () => ({
  api: {
    chats: { save: { useMutation: () => ({ mutate: mocks.saveChat }) } },
  },
}));

vi.mock("@web/components/ai-elements/prompt-input", () => ({
  PromptInput: ({
    children,
    onSubmit,
  }: {
    children: ReactNode;
    onSubmit: (message: PromptInputMessage) => void | Promise<void>;
  }) => {
    mocks.promptSubmit = onSubmit;
    return <form>{children}</form>;
  },
  PromptInputBody: ({ children }: { children: ReactNode }) => children,
  PromptInputFooter: ({ children }: { children: ReactNode }) => children,
  PromptInputSubmit: () => <button type="submit">Send</button>,
  PromptInputTextarea: () => <textarea />,
  PromptInputTools: () => null,
}));

vi.mock("../../../_components/composer-files", () => ({
  ComposerAttachButton: () => null,
  ComposerAttachments: () => null,
  ComposerNotice: () => null,
}));

import { ChatInput } from ".";

const send = vi.fn<ChatAgent["send"]>();

function renderInput(status: ChatAgent["status"]) {
  renderToStaticMarkup(
    <ChatInput
      agent={{
        cancel: async () => ({ status: "no_active_turn" }),
        data: { messages: [] },
        send,
        status,
      }}
      filesPilot
      sessionId="session-1"
    />
  );
}

const photo: PromptInputMessage = {
  files: [
    {
      filename: "скан.jpg",
      mediaType: "image/jpeg",
      type: "file",
      url: "data:image/jpeg;base64,AAAA",
    },
  ],
  text: "Вот скан",
};

describe("chat input", () => {
  beforeEach(() => {
    send.mockReset();
    mocks.promptSubmit = undefined;
    mocks.saveChat.mockReset();
  });

  it("keeps a message eve refused", async () => {
    send.mockRejectedValue(new ClientError(413, "{}"));
    renderInput("ready");

    await expect(mocks.promptSubmit?.(photo)).rejects.toBeInstanceOf(
      ClientError
    );
  });

  // The hook marks a failure after eve took the message: sending it again
  // would repeat the turn.
  it("lets go of a message eve took", async () => {
    send.mockRejectedValue(
      new Error("The message was delivered; following its turn failed.")
    );
    renderInput("ready");

    await expect(mocks.promptSubmit?.(photo)).resolves.toBeUndefined();
  });

  it("keeps a message written while the conversation is still loading", async () => {
    renderInput("resuming");

    await expect(mocks.promptSubmit?.(photo)).rejects.toThrow(
      "The conversation is not ready for a message yet."
    );
    expect(send).not.toHaveBeenCalled();
  });
});

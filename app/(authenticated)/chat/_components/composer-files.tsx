"use client";

import { FileIcon, FileTextIcon, PaperclipIcon, XIcon } from "lucide-react";
import {
  PromptInputButton,
  PromptInputHeader,
  usePromptInputAttachments,
} from "@web/components/ai-elements/prompt-input";
import { webMessageFiles } from "@shared/chat/web-files";

const fileMegabytes = String(webMessageFiles.maxFileSize / 1024 / 1024);

/** One tap opens the file picker: a single action, no menu, on a phone too. */
export function ComposerAttachButton({
  disabled,
}: {
  readonly disabled?: boolean;
}) {
  const attachments = usePromptInputAttachments();
  return (
    <PromptInputButton
      aria-label="Приложить файл"
      disabled={disabled}
      onClick={() => {
        attachments.openFileDialog();
      }}
      tooltip={`Фото, PDF и документы — до ${fileMegabytes} МБ`}
    >
      <PaperclipIcon className="size-4" />
    </PromptInputButton>
  );
}

/**
 * The files the next message carries, each with a way to take it off: a
 * pasted or dropped file shows here before it is sent. Square, like the
 * paper composer they sit in.
 */
export function ComposerAttachments() {
  const attachments = usePromptInputAttachments();
  if (attachments.files.length === 0) return null;
  return (
    <PromptInputHeader>
      <ul aria-label="Приложенные файлы" className="flex flex-wrap gap-1">
        {attachments.files.map((file) => {
          const name =
            file.filename === undefined || file.filename.length === 0
              ? "файл"
              : file.filename;
          return (
            <li
              className="flex max-w-56 items-center gap-1.5 border border-border py-0.5 pr-0.5 pl-1.5 type-caption"
              key={file.id}
            >
              <FileGlyph mediaType={file.mediaType} url={file.url} />
              <span className="truncate">{name}</span>
              <PromptInputButton
                aria-label={`Убрать «${name}»`}
                onClick={() => {
                  attachments.remove(file.id);
                }}
                size="icon-xs"
              >
                <XIcon />
              </PromptInputButton>
            </li>
          );
        })}
      </ul>
    </PromptInputHeader>
  );
}

function FileGlyph({
  mediaType,
  url,
}: {
  readonly mediaType: string;
  readonly url: string;
}) {
  if (mediaType.startsWith("image/")) {
    return (
      // A local blob URL cannot be declared in Next Image configuration.
      // oxlint-disable-next-line nextjs/no-img-element -- local blob URL of a file not yet sent
      <img alt="" className="size-5 shrink-0 object-cover" src={url} />
    );
  }
  const Icon = mediaType === "application/pdf" ? FileTextIcon : FileIcon;
  return <Icon className="size-3.5 shrink-0 text-muted-foreground" />;
}

/** A line under the composer: why a file stayed out or a message failed. */
export function ComposerNotice({ text }: { readonly text?: string }) {
  if (text === undefined) return null;
  return (
    <p className="type-status pt-1.5 text-destructive" role="alert">
      {text}
    </p>
  );
}

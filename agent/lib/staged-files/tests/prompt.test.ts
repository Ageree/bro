import { describe, expect, it } from "vitest";
import type { Prompt, PromptMessage } from "@agent/lib/model/prompt";
import { rememberAnnotations } from "../annotations";
import { withStagedFiles } from "../prompt";

const plainPdf = new Uint8Array(
  Buffer.from(
    "%PDF-1.7\n1 0 obj << /Type /Pages /Count 2 >> endobj\n%%EOF\n",
    "latin1"
  )
);
const lockedPdf = new Uint8Array(
  Buffer.from(
    "%PDF-1.7\ntrailer << /Encrypt 9 0 R /Root 1 0 R >>\n%%EOF\n",
    "latin1"
  )
);

/** A staged path, its hash made of the digit `n`. */
function staged(n: number, name = "_.pdf") {
  return `/workspace/attachments/${String(n).repeat(16)}/${name}`;
}

function person(
  ...content: Extract<PromptMessage, { role: "user" }>["content"]
) {
  return { content, role: "user" } satisfies PromptMessage;
}

function pdfPart(path: string, bytes = plainPdf) {
  return {
    data: { data: bytes, type: "data" },
    filename: path,
    mediaType: "application/pdf",
    type: "file",
  } as const;
}

function photo(path: string) {
  return {
    data: { data: new Uint8Array([1, 2, 3]), type: "data" },
    filename: path,
    mediaType: "image/png",
    type: "file",
  } as const;
}

const answer = {
  content: [{ text: "Готово.", type: "text" }],
  role: "assistant",
} satisfies PromptMessage;

function texts(message: PromptMessage | undefined) {
  if (message?.role !== "user") return [];
  return message.content.flatMap((part) =>
    part.type === "text" ? [part.text] : []
  );
}

function files(message: PromptMessage | undefined) {
  if (message?.role !== "user") return [];
  return message.content.flatMap((part) =>
    part.type === "file" ? [part.filename] : []
  );
}

describe("withStagedFiles", () => {
  it("keeps this turn's PDF with its path and turns an earlier one into its line", () => {
    const earlier = staged(1);
    const current = staged(2);
    const prompt: Prompt = [
      person({ text: "вот анкета", type: "text" }, pdfPart(earlier)),
      answer,
      person({ text: "а теперь эта", type: "text" }, pdfPart(current)),
    ];

    const { pdfs, prompt: sent } = withStagedFiles(prompt);

    expect(files(sent[0])).toEqual([]);
    expect(texts(sent[0]).join("\n")).toContain(earlier);
    expect(files(sent[2])).toEqual([current]);
    expect(texts(sent[2]).join("\n")).toContain(current);
    expect(pdfs).toMatchObject({ current: 1, earlier: 1, encrypted: 0 });
  });

  it("never sends a PDF locked with a password", () => {
    const locked = staged(3);
    const { pdfs, prompt } = withStagedFiles([
      person(pdfPart(locked, lockedPdf)),
    ]);

    expect(files(prompt[0])).toEqual([]);
    expect(texts(prompt[0]).join("\n")).toContain(locked);
    expect(pdfs.encrypted).toBe(1);
  });

  it("tells the model it does not see a photo eve could not inline", () => {
    const line = `Attached file ${staged(4, "IMG_0001.JPG")} (image/jpeg)`;
    const { prompt } = withStagedFiles([person({ text: line, type: "text" })]);

    const [text] = texts(prompt[0]);
    expect(text?.startsWith(line)).toBe(true);
    expect(text?.length).toBeGreaterThan(line.length);
  });

  it("turns an earlier turn's photo into its line in the pilot only", () => {
    const earlier = staged(3, "poster.png");
    const current = staged(4, "receipt.jpg");
    const prompt: Prompt = [
      person({ text: "что на афише?", type: "text" }, photo(earlier)),
      answer,
      person({ text: "а на чеке?", type: "text" }, photo(current)),
    ];

    const piloted = withStagedFiles(prompt, { earlierPhotos: true }).prompt;
    expect(files(piloted[0])).toEqual([]);
    expect(texts(piloted[0]).join("\n")).toContain(
      `Attached file ${earlier} (image/png) — фото из прошлого сообщения`
    );
    expect(files(piloted[2])).toEqual([current]);

    const plain = withStagedFiles(prompt).prompt;
    expect(files(plain[0])).toEqual([earlier]);
  });

  it("leaves a prompt without staged files as it is", () => {
    const prompt: Prompt = [
      person(
        { text: "что на фото?", type: "text" },
        {
          data: { data: plainPdf, type: "data" },
          filename: "scan.pdf",
          mediaType: "application/pdf",
          type: "file",
        }
      ),
      answer,
    ];

    expect(withStagedFiles(prompt).prompt).toBe(prompt);
  });

  it("hands the step before's parse to the answer after this turn's PDF only", () => {
    const earlier = staged(5);
    const current = staged(6);
    rememberAnnotations({
      openrouter: {
        annotations: [
          { file: { hash: "parse-5", name: earlier }, type: "file" },
          {
            file: {
              content: [{ text: "Анкета", type: "text" }],
              hash: "parse-6",
              name: current,
            },
            type: "file",
          },
        ],
      },
    });
    const call = {
      content: [
        {
          input: { message: `заполни ${current}` },
          toolCallId: "call-1",
          toolName: "task",
          type: "tool-call",
        },
      ],
      role: "assistant",
    } satisfies PromptMessage;
    const prompt: Prompt = [
      person(pdfPart(earlier)),
      answer,
      person(pdfPart(current)),
      call,
      {
        content: [
          {
            output: { type: "text", value: "готово" },
            toolCallId: "call-1",
            toolName: "task",
            type: "tool-result",
          },
        ],
        role: "tool",
      },
    ];

    const { pdfs, prompt: sent } = withStagedFiles(prompt);

    expect(sent[1]).toBe(answer);
    expect(sent[3]?.providerOptions).toEqual({
      openrouter: {
        annotations: [
          {
            file: {
              content: [{ text: "Анкета", type: "text" }],
              hash: "parse-6",
              name: current,
            },
            type: "file",
          },
        ],
      },
    });
    expect(pdfs.annotated).toBe(1);
  });
});

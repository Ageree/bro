import { describe, expect, it } from "vitest";
import { chatTitle, messageContent } from "./message-input";

describe("chat message input", () => {
  it("uses trimmed text directly when there are no attachments", () => {
    expect(messageContent({ files: [], text: "  Hello  " })).toBe("Hello");
  });

  it("builds multimodal content without an empty text part", () => {
    expect(
      messageContent({
        files: [
          {
            filename: "receipt.png",
            mediaType: "image/png",
            type: "file",
            url: "data:image/png;base64,example",
          },
        ],
        text: "  ",
      })
    ).toEqual([
      {
        data: "data:image/png;base64,example",
        filename: "receipt.png",
        mediaType: "image/png",
        type: "file",
      },
    ]);
  });

  // eve echoes a `data:` URL whole into the session stream; bare base64 it
  // does not. Thumbnails stay only while the images fit 1 MiB together.
  it("keeps data URLs only for the images within the thumbnail budget", () => {
    const photo = Buffer.alloc(700 * 1024, 7);
    const url = `data:image/jpeg;base64,${photo.toString("base64")}`;
    const pdf = Buffer.from("%PDF-1.7 скан");

    const parts = messageContent({
      files: [
        { filename: "a.jpg", mediaType: "image/jpeg", type: "file", url },
        { filename: "b.jpg", mediaType: "image/jpeg", type: "file", url },
        {
          filename: "скан.pdf",
          mediaType: "application/pdf",
          type: "file",
          url: `data:application/pdf;base64,${pdf.toString("base64")}`,
        },
        {
          filename: "notes.md",
          mediaType: "",
          type: "file",
          url: `data:;base64,${Buffer.from("# hi").toString("base64")}`,
        },
      ],
      text: "",
    });

    expect(parts).toMatchObject([
      { data: url, mediaType: "image/jpeg" },
      { data: photo.toString("base64"), mediaType: "image/jpeg" },
      { data: pdf.toString("base64"), mediaType: "application/pdf" },
      { filename: "notes.md", mediaType: "application/octet-stream" },
    ]);
  });

  it("derives a title from text before falling back to a filename", () => {
    expect(chatTitle({ files: [], text: "  Plan a trip  " })).toBe(
      "Plan a trip"
    );
    expect(
      chatTitle({
        files: [
          {
            filename: "receipt.png",
            mediaType: "image/png",
            type: "file",
            url: "data:image/png;base64,example",
          },
        ],
        text: "",
      })
    ).toBe("receipt.png");
  });

  it("calls a chat that has neither text nor a file name a new chat, in Russian", () => {
    expect(
      chatTitle({
        files: [
          {
            mediaType: "image/png",
            type: "file",
            url: "data:image/png;base64,example",
          },
        ],
        text: "   ",
      })
    ).toBe("Новый чат");
  });
});

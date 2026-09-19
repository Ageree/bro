import { describe, expect, it } from "vitest";
import {
  fileNote,
  inboundTurn,
  voiceRetryText,
  voiceUnsupportedText,
} from "./turn-content";

const jpeg = new Uint8Array([0xff, 0xd8, 0xff]);
const jpegBase64 = Buffer.from(jpeg).toString("base64");

describe("inbound turn assembly", () => {
  it("keeps a plain text message as a string", () => {
    expect(inboundTurn("  привет  ", [])).toEqual({
      message: "привет",
      notice: undefined,
    });
  });

  it("labels a photo without a caption so the model knows it is there", () => {
    const turn = inboundTurn("", [
      {
        data: jpeg,
        filename: "photo.jpg",
        kind: "image",
        mediaType: "image/jpeg",
      },
    ]);

    expect(turn.notice).toBeUndefined();
    expect(turn.message).toEqual([
      { text: "[фото]", type: "text" },
      {
        data: jpegBase64,
        filename: "photo.jpg",
        mediaType: "image/jpeg",
        type: "file",
      },
    ]);
  });

  it("encodes image and PDF bytes as a base64 string, not raw bytes", () => {
    const turn = inboundTurn("что это?", [
      {
        data: jpeg,
        filename: "photo.jpg",
        kind: "image",
        mediaType: "image/jpeg",
      },
      { data: jpeg, filename: "scan.pdf", kind: "pdf" },
    ]);

    if (!Array.isArray(turn.message)) {
      throw new Error("Expected file parts alongside the caption.");
    }
    const files = turn.message.filter(
      (part): part is Extract<typeof part, { type: "file" }> =>
        part.type === "file"
    );
    expect(files).toHaveLength(2);
    for (const file of files) {
      expect(file.data).toBe(jpegBase64);
    }
    // A raw Uint8Array/Buffer is not a plain JSON value and breaks eve's
    // durable dynamic-tool closures, which JSON-serialize the whole turn;
    // a base64 string keeps the message plain-JSON-serializable.
    expect(() => JSON.stringify(turn.message)).not.toThrow();
    expect(JSON.parse(JSON.stringify(turn.message))).toEqual(turn.message);
  });

  it("puts the caption before the file parts and marks a PDF as a document", () => {
    const turn = inboundTurn("что это?", [
      { data: jpeg, filename: "scan.pdf", kind: "pdf" },
    ]);

    expect(turn.message).toEqual([
      { text: "что это?", type: "text" },
      {
        data: jpegBase64,
        filename: "scan.pdf",
        mediaType: "application/pdf",
        type: "file",
      },
    ]);
    expect(
      inboundTurn("", [{ data: jpeg, filename: "scan.pdf", kind: "pdf" }])
        .message
    ).toEqual([
      { text: "[документ]", type: "text" },
      expect.objectContaining({ mediaType: "application/pdf" }),
    ]);
  });

  it("renders a transcript with the voice marker under the caption", () => {
    expect(
      inboundTurn("см. ниже", [{ kind: "transcript", text: " купи молоко " }])
    ).toEqual({
      message: "см. ниже\n[голосовое] купи молоко",
      notice: undefined,
    });
  });

  it("asks for a retry when every voice note failed and nothing else was said", () => {
    expect(inboundTurn("", [{ kind: "voice-failed" }])).toEqual({
      message: undefined,
      notice: voiceRetryText,
    });
  });

  it("tells the model about a failed voice note next to other content", () => {
    expect(inboundTurn("и ещё это", [{ kind: "voice-failed" }]).message).toBe(
      "и ещё это\n[голосовое не распозналось]"
    );
  });

  it("says voice is unsupported and still runs the rest of the message", () => {
    expect(inboundTurn("", [{ kind: "voice-unsupported" }])).toEqual({
      message: undefined,
      notice: voiceUnsupportedText,
    });
    const withPhoto = inboundTurn("", [
      { kind: "voice-unsupported" },
      {
        data: jpeg,
        filename: "photo.jpg",
        kind: "image",
        mediaType: "image/jpeg",
      },
    ]);
    expect(withPhoto.notice).toBe(voiceUnsupportedText);
    expect(withPhoto.message).toEqual([
      { text: "[фото]", type: "text" },
      expect.objectContaining({ type: "file" }),
    ]);
  });

  it("describes an unsupported file in one line", () => {
    expect(fileNote("report.docx", "application/msword")).toBe(
      "[файл: report.docx (application/msword)]"
    );
    expect(fileNote(undefined, undefined, "слишком большой")).toBe(
      "[файл: без имени (неизвестный тип), слишком большой]"
    );
    expect(
      inboundTurn("", [
        { kind: "note", text: "[файл: a.zip (application/zip)]" },
      ]).message
    ).toBe("[файл: a.zip (application/zip)]");
  });
});

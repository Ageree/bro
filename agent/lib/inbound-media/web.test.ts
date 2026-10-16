import { describe, expect, it } from "vitest";
import { zipWith } from "@tests/helpers/zip-archive";
import { webFileNotes } from "./web";

const pdf = Buffer.from("%PDF-1.7\n%âãÏÓ\n1 0 obj\n", "latin1");
const jpeg = Buffer.from([
  0xff, 0xd8, 0xff, 0xe0, 0, 0x10, 0x4a, 0x46, 0x49, 0x46, 0, 1, 1,
]);
const brokenZip = zipWith({
  entries: [{ content: "0", declaredSize: 300 * 1024 * 1024, name: "z" }],
});

describe("webFileNotes", () => {
  it("names each file part in order, under its heading", () => {
    const notes = webFileNotes([
      { text: "заполни анкету и проверь чеки", type: "text" },
      {
        data: pdf.toString("base64"),
        filename: "Анкета секция №2.pdf",
        mediaType: "application/pdf",
        type: "file",
      },
      {
        data: `data:image/jpeg;base64,${jpeg.toString("base64")}`,
        filename: "IMG_0001.JPG",
        mediaType: "image/jpeg",
        type: "file",
      },
      {
        data: Buffer.from(brokenZip).toString("base64"),
        filename: "Чеки.zip",
        mediaType: "application/octet-stream",
        type: "file",
      },
      {
        data: Buffer.from("Rar!\u001a\u0007\u0000").toString("base64"),
        filename: "сканы.rar",
        mediaType: "application/x-rar-compressed",
        type: "file",
      },
    ]);

    expect(notes.slice(1)).toEqual([
      "[файл: Анкета секция №2.pdf (application/pdf)]",
      "[файл: IMG_0001.JPG (image/jpeg)]",
      "[файл: Чеки.zip (application/zip), архив повреждён или слишком велик]",
      "[файл: сканы.rar (application/x-rar-compressed), архив RAR или 7z не открыть — нужен ZIP]",
    ]);
    expect(notes[0]).toMatch(/^Файлы, приложенные к сообщению/u);
  });

  it("adds nothing to a message without files", () => {
    expect(webFileNotes("привет")).toEqual([]);
    expect(webFileNotes([{ text: "привет", type: "text" }])).toEqual([]);
  });
});

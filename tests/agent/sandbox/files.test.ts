import { afterEach, describe, expect, it, vi } from "vitest";
import {
  clearSandboxSettings,
  importWithSandbox,
} from "@tests/helpers/sandbox";

afterEach(() => {
  clearSandboxSettings();
  vi.unstubAllGlobals();
  vi.resetModules();
});

const files = async () =>
  await importWithSandbox(async () => await import("@agent/lib/sandbox/files"));

describe("shared sandbox files", () => {
  it("names a file the way a messenger shows it", async () => {
    const { sharedFileName } = await files();
    expect(sharedFileName("/workspace/out/Отчёт за сентябрь.pdf")).toBe(
      "Отчёт за сентябрь.pdf"
    );
    expect(sharedFileName("../..")).toBe("file");
    expect(sharedFileName("a\u0000b<c>.txt")).toBe("ab_c_.txt");
    // A long name keeps the extension that tells what opens it.
    const long = sharedFileName(`/workspace/${"Отчёт ".repeat(40)}.docx`);
    expect(long).toHaveLength(120);
    expect(long).toMatch(/^Отчёт Отчёт .*\.docx$/u);
    expect(sharedFileName(long)).toBe(long);
  });

  it("stores the bytes and links them with a signature only for them", async () => {
    const puts: string[] = [];
    vi.stubGlobal("fetch", (url: string, init: RequestInit) => {
      expect(init.method).toBe("PUT");
      expect(init.body).toEqual(Buffer.from("x"));
      expect(new Headers(init.headers).get("content-type")).toBe("text/plain");
      puts.push(url);
      return Promise.resolve(new Response(null, { status: 200 }));
    });
    const { shareSandboxFile, sharedFileLocation } = await files();
    const shared = await shareSandboxFile({
      bytes: new TextEncoder().encode("x"),
      mediaType: "text/plain",
      name: "итог (1).txt",
    });
    const link = new URL(shared.url);
    expect(link.origin).toBe("https://bro.example.test");
    const [, , , , id, name] = link.pathname.split("/");
    expect(puts[0]).toContain(`/bro-state-test/sandbox/files/${id ?? ""}/`);
    const location = sharedFileLocation({
      id: id ?? "",
      name: decodeURIComponent(name ?? ""),
      signature: link.searchParams.get("sig"),
    });
    expect(decodeURIComponent(name ?? "")).toBe("итог (1).txt");
    expect(location).toContain(`/sandbox/files/${id ?? ""}/`);
    // Downloaded, never rendered on the storage's origin.
    expect(
      new URL(location ?? "https://x").searchParams.get(
        "response-content-disposition"
      )
    ).toBe(
      `attachment; filename*=UTF-8''${encodeURIComponent("итог")}%20%281%29.txt`
    );
    expect(
      sharedFileLocation({
        id: id ?? "",
        name: "другой.txt",
        signature: link.searchParams.get("sig"),
      })
    ).toBeUndefined();
    expect(
      sharedFileLocation({ id: "nothex", name: "итог (1).txt", signature: "x" })
    ).toBeUndefined();
  });
});

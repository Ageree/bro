import { describe, expect, it } from "vitest";
import {
  objectRequestTimeoutMs,
  uploadTimeoutMs,
} from "@shared/object-storage/upload-timeout";

describe("upload timeout", () => {
  it("grows with the body at the slowest rate on top of a read's bound", () => {
    expect(uploadTimeoutMs(0)).toBe(objectRequestTimeoutMs);
    expect(uploadTimeoutMs(1)).toBe(objectRequestTimeoutMs + 1000);
    expect(uploadTimeoutMs(10 * 1024 * 1024)).toBe(
      objectRequestTimeoutMs + 160_000
    );
  });
});

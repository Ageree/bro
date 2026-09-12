import { readFileSync } from "node:fs";

export function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(msg);
}

export function src(rel: string): string {
  return readFileSync(new URL("../../" + rel, import.meta.url), "utf8");
}

export function srcJson<T = unknown>(rel: string): T {
  return JSON.parse(src(rel)) as T;
}

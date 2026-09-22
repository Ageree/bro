import { z } from "zod";

export const browserImageSourceKinds = [
  "element",
  "full_page",
  "image_resource",
  "viewport",
] as const;

export function isBrowserImageArtifactUrl(value: string) {
  const parsed = /^\/artifacts\/([^/]+)$/u.exec(value);
  if (!parsed?.[1]) return false;
  return z.uuid().safeParse(decodeURIComponent(parsed[1])).success;
}

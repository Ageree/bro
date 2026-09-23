/**
 * The Notion REST contract the connection and `notion-add-task` share. The
 * version is pinned: the published spec describes one version at a time, and
 * a request under another may answer in a different shape.
 */
export const notionApi = {
  baseUrl: "https://api.notion.com",
  spec: "https://developers.notion.com/openapi.json",
  version: "2026-03-11",
} as const;

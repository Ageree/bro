import { readdir, readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  eveChannelRoutePaths,
  insertEveChannelRoutes,
} from "./eve-channel-routes";

const channelsDirectory = fileURLToPath(
  new URL("agent/channels", import.meta.url)
);

// `POST("/webhooks/browser-use", …)` and its siblings in a channel definition.
const routeLiteral = /\b(?:DELETE|GET|PATCH|POST|PUT)\(\s*"(?<path>\/[^"]*)"/gu;

describe("eveChannelRoutePaths", () => {
  it("carries every custom route the agent channels declare", async () => {
    const entries = await readdir(channelsDirectory);
    const sources = await Promise.all(
      entries.map((entry) => readFile(`${channelsDirectory}/${entry}`, "utf8"))
    );
    const declared = new Set<string>();
    for (const match of sources.join("\n").matchAll(routeLiteral)) {
      const path = match.groups?.path;
      // The framework-owned namespace is published by `withEve` itself.
      if (path && !path.startsWith("/eve/v1/")) declared.add(path);
    }
    expect([...declared].toSorted()).toStrictEqual(
      [...eveChannelRoutePaths].toSorted()
    );
  });
});

describe("insertEveChannelRoutes", () => {
  it("routes each path to the eve service ahead of the filesystem handler", () => {
    const routes = insertEveChannelRoutes(
      [{ src: "^/eve/v1/(.*)$" }, { handle: "filesystem" }, { src: "^/(.*)$" }],
      "eve"
    );
    expect(routes).toStrictEqual([
      { src: "^/eve/v1/(.*)$" },
      {
        destination: { service: "eve", type: "service" },
        src: "^/internal/scheduled-run/report$",
      },
      {
        destination: { service: "eve", type: "service" },
        src: "^/internal/scheduled-run/respond$",
      },
      {
        destination: { service: "eve", type: "service" },
        src: "^/webhooks/browser-use$",
      },
      { handle: "filesystem" },
      { src: "^/(.*)$" },
    ]);
  });

  it("republishes its own routes instead of duplicating them", () => {
    const once = insertEveChannelRoutes([{ handle: "filesystem" }], "eve");
    expect(insertEveChannelRoutes(once, "eve")).toStrictEqual(once);
  });
});

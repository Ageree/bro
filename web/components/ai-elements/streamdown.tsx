"use client";

import { useEffect, useSyncExternalStore } from "react";
import type {
  PluginConfig,
  Streamdown as StreamdownComponent,
  StreamdownProps,
} from "streamdown";
import { cn } from "@web/components/class-names";

type PluginName = Exclude<keyof PluginConfig, "renderers">;

// Streamdown is the heaviest part of the chat page: its markdown parser alone
// is ~420 KiB, and every plugin weighs hundreds more (Shiki, KaTeX, Mermaid
// with its graph layouts). The parser loads beside the conversation's history
// request, and a plugin loads the first time a message's markdown calls for
// it; until then the text shows as it is.
const loaders = {
  cjk: async () => (await import("@streamdown/cjk")).cjk,
  code: async () => (await import("@streamdown/code")).code,
  math: async () => (await import("@streamdown/math")).math,
  mermaid: async () => (await import("@streamdown/mermaid")).mermaid,
} satisfies {
  readonly [Name in PluginName]: () => Promise<NonNullable<PluginConfig[Name]>>;
};

const callsFor: Readonly<Record<PluginName, RegExp>> = {
  cjk: /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u,
  code: /```|~~~/,
  // The math plugin reads only `$$`: single-dollar math is off.
  math: /\$\$/,
  mermaid: /(?:```|~~~)\s*mermaid/i,
};

const pluginNames = ["cjk", "code", "math", "mermaid"] as const;

interface Loaded {
  readonly plugins: PluginConfig;
  readonly Streamdown?: typeof StreamdownComponent;
}

const nothingLoaded: Loaded = { plugins: {} };
// A new object on every load, so Streamdown's memo holds between loads.
let loaded = nothingLoaded;
const listeners = new Set<() => void>();
const loading = new Map<string, Promise<void>>();

function settle(next: Loaded) {
  loaded = next;
  for (const listener of listeners) listener();
}

function load(name: string, run: () => Promise<Loaded>) {
  const started = loading.get(name);
  if (started) return started;
  const promise = run().then(settle, (cause: unknown) => {
    // A failed chunk leaves the text plain; the next message asks again.
    loading.delete(name);
    console.warn(`[chat] streamdown ${name} did not load`, cause);
  });
  loading.set(name, promise);
  return promise;
}

function loadParser() {
  return load("parser", async () => {
    const { Streamdown } = await import("streamdown");
    return { ...loaded, Streamdown };
  });
}

function loadPlugin(name: PluginName) {
  return load(name, async () => {
    const plugin = await loaders[name]();
    return { ...loaded, plugins: { ...loaded.plugins, [name]: plugin } };
  });
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Streamdown with its parser and plugins loaded on demand. */
export function LazyStreamdown(props: Omit<StreamdownProps, "plugins">) {
  const current = useSyncExternalStore(
    subscribe,
    () => loaded,
    () => nothingLoaded
  );
  const markdown = props.children ?? "";
  const missing = pluginNames
    .filter(
      (name) =>
        current.plugins[name] === undefined && callsFor[name].test(markdown)
    )
    .join(",");
  const parserLoaded = current.Streamdown !== undefined;

  useEffect(() => {
    if (!parserLoaded) void loadParser();
    const names = missing.split(",");
    for (const name of pluginNames) {
      if (names.includes(name)) void loadPlugin(name);
    }
  }, [missing, parserLoaded]);

  const { Streamdown } = current;
  if (!Streamdown) {
    return (
      <div className={cn("whitespace-pre-wrap", props.className)}>
        {markdown}
      </div>
    );
  }
  return <Streamdown {...props} plugins={current.plugins} />;
}

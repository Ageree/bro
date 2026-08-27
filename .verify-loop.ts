import { readFileSync } from "node:fs";
import { Inkbox } from "@inkbox/sdk";
for (const line of readFileSync(".env.local", "utf8").split("\n")) {
  const t = line.trim(); if (!t || t.startsWith("#")) continue;
  const i = t.indexOf("="); if (i < 0) continue;
  if (process.env[t.slice(0, i)] === undefined) process.env[t.slice(0, i)] = t.slice(i + 1);
}
const identity = await new Inkbox().getIdentity(process.env.INKBOX_AGENT_HANDLE ?? "bro-ageree");
for (let i = 0; i < 20; i++) {
  await new Promise((r) => setTimeout(r, 10000));
  const msgs = (await identity.listIMessages({ limit: 1 } as any)) as any[];
  const top = msgs[0];
  const text = String(top.text ?? top.content ?? "");
  if (top.direction === "outbound" && /круг|Convex|крон|✅/i.test(text)) {
    console.log("FULL-LOOP OUTBOUND:", top.status, top.service, JSON.stringify(text.slice(0, 160)));
    process.exit(0);
  }
}
console.log("NO FULL-LOOP OUTBOUND after 200s");
process.exit(1);

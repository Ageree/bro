// Живой прогон координатора: шлёт Бро сообщения от имени владельца в новом
// веб-разговоре и печатает время каждого события хода от отправки.
// node .claude/plan/probe.mjs <cookie-jar> "сообщение 1" ["сообщение 2" …]
import { readFile } from "node:fs/promises";
import { Client } from "eve/client";

const [jar, ...messages] = process.argv.slice(2);
const host = new URL(process.env.BRO_HOST ?? "https://brobro.tech");
const cookie = (await readFile(jar, "utf8"))
  .split("\n")
  .map((line) => line.replace(/^#HttpOnly_/u, "").split("\t"))
  .filter((fields) => fields.length === 7 && !fields[0].startsWith("#"))
  .map((fields) => `${fields[5]}=${fields[6]}`)
  .join("; ");
const client = new Client({
  headers: { cookie, origin: host.origin },
  host: host.origin,
  redirect: "manual",
});

const brief = (event) => {
  const text = JSON.stringify(event.data ?? event).replace(/\s+/gu, " ");
  return text.length > 400 ? `${text.slice(0, 400)}…` : text;
};

async function readTurn(label, events, started) {
  console.log(`\n=== ${label}`);
  for await (const event of events) {
    const at = ((Date.now() - started) / 1000).toFixed(1).padStart(6);
    console.log(`${at}s ${event.type} ${brief(event)}`);
  }
  console.log(`=== ход закончен за ${((Date.now() - started) / 1000).toFixed(1)} с`);
}

let session;
for (const message of messages) {
  const started = Date.now();
  if (session) {
    await readTurn(message, await session.send(message), started);
  } else {
    const created = await client.sessions.create({ message });
    session = created.session;
    console.log(`session ${session.id}`);
    await readTurn(message, created.response, started);
  }
}

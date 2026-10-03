import { randomUUID } from "node:crypto";
import { expect } from "e2e";
import { Client } from "pg";
import { accessScopeForUser } from "../../shared/identity/access-scope.ts";
import { e2eEnv } from "../env.ts";
import { ownPersonTest } from "../person.ts";
import { crossChannelPilotEmail } from "../pilots.ts";
import { chatLog, sendToBro } from "./bro.ts";

const database = e2eEnv.E2E_DATABASE_URL;

const telegramRequest = "Напомни мне купить билеты в Казань на пятницу";

/**
 * What the person said to Bro in Telegram, as the conversation log keeps it
 * (`agent/hooks/conversation-log.ts`): the suite has no Telegram, so the
 * test writes the line into the run's database itself. The workspace was
 * introduced there already, as a person who wrote in Telegram first is.
 * The person takes the email the app's pilot list names (e2e/pilots.ts),
 * from whoever had it in an earlier run or attempt.
 */
async function seedTelegramConversation(url: string, phone: string) {
  const client = new Client({ connectionString: url });
  await client.connect();
  try {
    const found = await client.query<{ id: string }>(
      `SELECT id FROM "user" WHERE "phoneNumber" = $1`,
      [phone]
    );
    const userId = found.rows[0]?.id;
    if (userId === undefined) throw new Error("The person has no account.");
    const scope = accessScopeForUser(`better-auth:${userId}`);
    await client.query(
      `UPDATE "user" SET email = 'released-' || id || '@e2e.invalid' WHERE email = $1`,
      [crossChannelPilotEmail]
    );
    await client.query(`UPDATE "user" SET email = $1 WHERE id = $2`, [
      crossChannelPilotEmail,
      userId,
    ]);
    const sessionId = `e2e-telegram-${randomUUID()}`;
    await client.query(
      `INSERT INTO workspaces (id, introduced_at) VALUES ($1, now())
       ON CONFLICT (id) DO UPDATE SET introduced_at = COALESCE(workspaces.introduced_at, now())`,
      [scope.workspaceId]
    );
    await client.query(
      `INSERT INTO workspace_memberships (workspace_id, user_id, role)
       VALUES ($1, $2, 'owner') ON CONFLICT DO NOTHING`,
      [scope.workspaceId, scope.userId]
    );
    await client.query(
      `INSERT INTO chats (session_id, workspace_id, channel, title)
       VALUES ($1, $2, 'channel:telegram', 'Telegram')`,
      [sessionId, scope.workspaceId]
    );
    await client.query(
      `INSERT INTO conversation_log (workspace_id, session_id, turn_id, channel, text, created_at)
       VALUES ($1, $2, 'turn_0', 'channel:telegram', $3, now() - interval '2 minutes')`,
      [scope.workspaceId, sessionId, telegramRequest]
    );
  } finally {
    await client.end();
  }
}

/**
 * docs/roadmap.md, item 28: in the pilot (CROSS_CHANNEL_WORKSPACES, by the
 * email of e2e/pilots.ts) a web chat is told what the person said to Bro in
 * another channel, and Bro answers about it.
 */
ownPersonTest(
  "Bro knows what the person wrote to it in Telegram",
  {
    skip:
      database === undefined &&
      "The test writes the Telegram line into E2E_DATABASE_URL, which is unset",
    tags: ["agent"],
    timeout: 300_000,
  },
  async ({ app, browser, phone, screen }) => {
    if (database === undefined) return;
    await seedTelegramConversation(database, phone);

    await app.open("/chat");
    const reply = await sendToBro(
      { browser, screen },
      "Что я писал тебе в телеграме?"
    );

    expect(reply).toMatch(/Казан/u);
    // The recap is the turn's context, never a message of the chat.
    await expect(chatLog(browser)).not.toContainText(
      "Background from the person's other chats"
    );
  }
);
